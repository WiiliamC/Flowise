import { AIMessageChunk } from '@langchain/core/messages'

const { nodeClass: AgentAgentflow } = require('./Agent')

describe('Agent AgentFlow streaming reasoning chunks', () => {
    it('streams reasoning-only chunks as thinking content without empty token events', async () => {
        const agentNode = new AgentAgentflow()
        const chunk = new AIMessageChunk({
            content: '',
            additional_kwargs: {
                reasoning_content: 'Think through the tool plan.'
            }
        })
        const llmNodeInstance = {
            stream: jest.fn(async function* () {
                yield chunk
            })
        }
        const sseStreamer = {
            streamThinkingEvent: jest.fn(),
            streamTokenEvent: jest.fn()
        }

        const response = await (agentNode as any).handleStreamingResponse(
            sseStreamer,
            llmNodeInstance,
            [],
            'chat-id',
            new AbortController(),
            false,
            true
        )

        expect(sseStreamer.streamThinkingEvent).toHaveBeenCalledWith('chat-id', 'Think through the tool plan.')
        expect(sseStreamer.streamThinkingEvent).toHaveBeenCalledWith('chat-id', '', expect.any(Number))
        expect(sseStreamer.streamTokenEvent).not.toHaveBeenCalled()
        expect(response.additional_kwargs?.reasoning_content).toBe('Think through the tool plan.')
    })

    const invokeToolCalls = async (agentNode: any, response: AIMessageChunk, toolsInstance: any[], sseStreamer: any) =>
        agentNode.handleToolCalls({
            response,
            messages: [],
            toolsInstance,
            sseStreamer,
            chatId: 'chat-id',
            input: 'input',
            options: {},
            abortController: new AbortController(),
            llmNodeInstance: { invoke: jest.fn().mockResolvedValue(new AIMessageChunk('done')) },
            isStreamable: false,
            isLastNode: false,
            iterationContext: {}
        })

    it('emits toolCallCompleted with the original ID and normalized output only when enabled', async () => {
        const agentNode = new AgentAgentflow()
        const streamToolCallCompletedEvent = jest.fn()
        const sseStreamer = {
            streamCalledToolsEvent: jest.fn(),
            streamToolCallCompletedEvent
        }
        const response = new AIMessageChunk({ content: '', tool_calls: [{ id: 'call-1', name: 'weather', args: { city: 'Tokyo' } }] })
        const tool = { name: 'weather', call: jest.fn().mockResolvedValue('sunny') }
        const oldValue = process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT

        delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        await invokeToolCalls(agentNode, response, [tool], sseStreamer)
        expect(streamToolCallCompletedEvent).not.toHaveBeenCalled()
        expect(sseStreamer.streamCalledToolsEvent).toHaveBeenLastCalledWith('chat-id', [
            {
                tool: 'weather',
                toolInput: { city: 'Tokyo' },
                toolOutput: ''
            }
        ])

        process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = 'true'
        await invokeToolCalls(
            agentNode,
            new AIMessageChunk({ content: '', tool_calls: [{ id: 'call-1', name: 'weather', args: { city: 'Tokyo' } }] }),
            [tool],
            sseStreamer
        )
        expect(sseStreamer.streamCalledToolsEvent).toHaveBeenLastCalledWith('chat-id', [
            {
                toolCallId: 'call-1',
                tool: 'weather',
                toolInput: { city: 'Tokyo' },
                toolOutput: ''
            }
        ])
        expect(streamToolCallCompletedEvent).toHaveBeenCalledWith('chat-id', {
            toolCallId: 'call-1',
            tool: 'weather',
            toolInput: { city: 'Tokyo' },
            toolOutput: 'sunny'
        })

        if (oldValue === undefined) delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        else process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = oldValue
    })

    it('emits completion errors for failed and unknown identified tool calls', async () => {
        const agentNode = new AgentAgentflow()
        const streamToolCallCompletedEvent = jest.fn()
        const sseStreamer = { streamCalledToolsEvent: jest.fn(), streamToolCallCompletedEvent, streamUsedToolsEvent: jest.fn() }
        const oldValue = process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        const consoleError = jest.spyOn(console, 'error').mockImplementation()
        process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = 'true'

        await expect(
            invokeToolCalls(
                agentNode,
                new AIMessageChunk({ content: '', tool_calls: [{ id: 'bad-1', name: 'failing', args: { value: 1 } }] }),
                [{ name: 'failing', call: jest.fn().mockRejectedValue(new Error('tool failed')) }],
                sseStreamer
            )
        ).rejects.toThrow('tool failed')
        expect(streamToolCallCompletedEvent).toHaveBeenLastCalledWith('chat-id', {
            toolCallId: 'bad-1',
            tool: 'failing',
            toolInput: { value: 1 },
            toolOutput: '',
            error: 'tool failed'
        })

        await invokeToolCalls(
            agentNode,
            new AIMessageChunk({ content: '', tool_calls: [{ id: 'missing-1', name: 'missing', args: {} }] }),
            [],
            sseStreamer
        )
        expect(streamToolCallCompletedEvent).toHaveBeenLastCalledWith('chat-id', {
            toolCallId: 'missing-1',
            tool: 'missing',
            toolInput: {},
            toolOutput: '',
            error: 'Tool not found: missing'
        })

        if (oldValue === undefined) delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        else process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = oldValue
        consoleError.mockRestore()
    })

    it('emits one completion per executed recursive tool call', async () => {
        const agentNode = new AgentAgentflow()
        const streamToolCallCompletedEvent = jest.fn()
        const sseStreamer = { streamCalledToolsEvent: jest.fn(), streamToolCallCompletedEvent }
        const oldValue = process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = 'true'
        const llmNodeInstance = {
            invoke: jest
                .fn()
                .mockResolvedValueOnce(
                    new AIMessageChunk({ content: '', tool_calls: [{ id: 'call-2', name: 'second', args: { step: 2 } }] })
                )
                .mockResolvedValueOnce(new AIMessageChunk('done'))
        }

        await (agentNode as any).handleToolCalls({
            response: new AIMessageChunk({ content: '', tool_calls: [{ id: 'call-1', name: 'first', args: { step: 1 } }] }),
            messages: [],
            toolsInstance: [
                { name: 'first', call: jest.fn().mockResolvedValue('first output') },
                { name: 'second', call: jest.fn().mockResolvedValue('second output') }
            ],
            sseStreamer,
            chatId: 'chat-id',
            input: 'input',
            options: {},
            abortController: new AbortController(),
            llmNodeInstance,
            isStreamable: false,
            isLastNode: false,
            iterationContext: {}
        })

        expect(streamToolCallCompletedEvent).toHaveBeenNthCalledWith(1, 'chat-id', {
            toolCallId: 'call-1',
            tool: 'first',
            toolInput: { step: 1 },
            toolOutput: 'first output'
        })
        expect(streamToolCallCompletedEvent).toHaveBeenNthCalledWith(2, 'chat-id', {
            toolCallId: 'call-2',
            tool: 'second',
            toolInput: { step: 2 },
            toolOutput: 'second output'
        })

        if (oldValue === undefined) delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        else process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = oldValue
    })

    it('emits completion only when an approved human-input tool call proceeds', async () => {
        const agentNode = new AgentAgentflow()
        const streamToolCallCompletedEvent = jest.fn()
        const sseStreamer = { streamCalledToolsEvent: jest.fn(), streamToolCallCompletedEvent }
        const oldValue = process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = 'true'
        const checkpoint = new AIMessageChunk({ content: '', tool_calls: [{ id: 'approval-1', name: 'approved', args: { ok: true } }] })
        const createArgs = (type: 'proceed' | 'reject') => ({
            humanInput: { type },
            humanInputAction: { data: { input: { messages: [checkpoint] } } },
            messages: [],
            toolsInstance: [{ name: 'approved', call: jest.fn().mockResolvedValue('approved output') }],
            sseStreamer,
            chatId: 'chat-id',
            input: 'input',
            options: {},
            abortController: new AbortController(),
            llmWithoutToolsBind: {
                invoke: jest.fn().mockResolvedValue(new AIMessageChunk('done')),
                bindTools: jest.fn(function () {
                    return this
                })
            },
            isStreamable: false,
            isLastNode: false,
            iterationContext: {}
        })

        await (agentNode as any).handleResumedToolCalls(createArgs('reject'))
        expect(streamToolCallCompletedEvent).not.toHaveBeenCalled()

        await (agentNode as any).handleResumedToolCalls(createArgs('proceed'))
        expect(streamToolCallCompletedEvent).toHaveBeenCalledWith('chat-id', {
            toolCallId: 'approval-1',
            tool: 'approved',
            toolInput: { ok: true },
            toolOutput: 'approved output'
        })

        if (oldValue === undefined) delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        else process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = oldValue
    })
})
