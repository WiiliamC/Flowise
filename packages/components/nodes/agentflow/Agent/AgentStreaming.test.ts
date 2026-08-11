import { AIMessageChunk } from '@langchain/core/messages'
import { DynamicStructuredTool, ToolInputParsingException } from '@langchain/core/tools'
import { z } from 'zod/v3'
import { DynamicStructuredTool as CustomTool } from '../../tools/CustomTool/core'
import { DynamicStructuredTool as OpenAPITool } from '../../tools/OpenAPIToolkit/core'

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

    it('announces validated tool calls before execution completes', async () => {
        const agentNode = new AgentAgentflow()
        const sseStreamer = { streamCalledToolsEvent: jest.fn() }
        let finishFirstTool: (value: string) => void = () => undefined
        const firstToolOutput = new Promise<string>((resolve) => {
            finishFirstTool = resolve
        })
        const execution = invokeToolCalls(
            agentNode,
            new AIMessageChunk({
                content: '',
                tool_calls: [
                    { id: 'call-1', name: 'first', args: { value: 1 } },
                    { id: 'call-2', name: 'second', args: { value: 2 } }
                ]
            }),
            [
                { name: 'first', call: jest.fn().mockReturnValue(firstToolOutput) },
                { name: 'second', call: jest.fn().mockResolvedValue('second output') }
            ],
            sseStreamer
        )

        await new Promise((resolve) => setImmediate(resolve))
        expect(sseStreamer.streamCalledToolsEvent).toHaveBeenCalledWith('chat-id', [
            { tool: 'first', toolInput: { value: 1 }, toolOutput: '' },
            { tool: 'second', toolInput: { value: 2 }, toolOutput: '' }
        ])

        finishFirstTool('first output')
        await execution
    })

    it('announces Flowise tool calls whose inputs are accepted through type conversion', async () => {
        const agentNode = new AgentAgentflow()
        const sseStreamer = { streamCalledToolsEvent: jest.fn() }
        const tool = new CustomTool({
            name: 'coercing_tool',
            description: 'coercing tool',
            code: '',
            schema: z.object({ topK: z.number() })
        })
        jest.spyOn(tool as any, '_call').mockResolvedValue('done')

        await invokeToolCalls(
            agentNode,
            new AIMessageChunk({
                content: '',
                tool_calls: [{ id: 'coercing-call', name: tool.name, args: { topK: '5' } }]
            }),
            [tool],
            sseStreamer
        )

        expect(sseStreamer.streamCalledToolsEvent).toHaveBeenCalledWith('chat-id', [
            { tool: 'coercing_tool', toolInput: { topK: '5' }, toolOutput: '' }
        ])
        expect((tool as any)._call.mock.calls[0][0]).toEqual({ topK: 5 })
    })

    it('does not stream arguments rejected by a native StructuredTool', async () => {
        const agentNode = new AgentAgentflow()
        const invalidValue = '5'
        const toolFunction = jest.fn().mockResolvedValue('done')
        const tool = new DynamicStructuredTool({
            name: 'native_tool',
            description: 'native tool',
            schema: z.object({ topK: z.number() }),
            func: toolFunction
        })
        const sseStreamer = { streamCalledToolsEvent: jest.fn() }

        await invokeToolCalls(
            agentNode,
            new AIMessageChunk({
                content: '',
                tool_calls: [{ id: 'native-call', name: tool.name, args: { topK: invalidValue } }]
            }),
            [tool],
            sseStreamer
        )

        expect(toolFunction).not.toHaveBeenCalled()
        expect(sseStreamer.streamCalledToolsEvent).toHaveBeenCalledWith('chat-id', [{ tool: 'native_tool', toolInput: {}, toolOutput: '' }])
        expect(JSON.stringify(sseStreamer.streamCalledToolsEvent.mock.calls)).not.toContain(invalidValue)
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

    it('returns sanitized validation errors to the model and allows a corrected tool-call round', async () => {
        const agentNode = new AgentAgentflow()
        const streamToolCallCompletedEvent = jest.fn()
        const sseStreamer = { streamCalledToolsEvent: jest.fn(), streamToolCallCompletedEvent, streamUsedToolsEvent: jest.fn() }
        const oldValue = process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = 'true'
        const invalidValue = 'do-not-leak-this'
        const llmNodeInstance = { invoke: jest.fn().mockResolvedValue(new AIMessageChunk('corrected')) }
        const messages: any[] = []
        const analyticHandlers = { onToolStart: jest.fn().mockResolvedValue({ tool: 'trace-id' }), onToolEnd: jest.fn() }

        const result = await (agentNode as any).handleToolCalls({
            response: new AIMessageChunk({ content: '', tool_calls: [{ id: 'invalid-1', name: 'weather', args: { city: invalidValue } }] }),
            messages,
            toolsInstance: [
                {
                    name: 'weather',
                    schema: {
                        safeParse: () => ({
                            success: false,
                            error: { issues: [{ path: ['city'], code: 'invalid_type', expected: 'number' }] }
                        })
                    },
                    call: jest
                        .fn()
                        .mockRejectedValue(
                            new ToolInputParsingException(
                                'Received tool input did not match expected schema',
                                JSON.stringify({ city: invalidValue })
                            )
                        )
                }
            ],
            sseStreamer,
            chatId: 'chat-id',
            input: 'input',
            options: { analyticHandlers },
            abortController: new AbortController(),
            llmNodeInstance,
            isStreamable: false,
            isLastNode: false,
            iterationContext: {}
        })

        expect(messages[1]).toMatchObject({ status: 'error', tool_call_id: 'invalid-1', name: 'weather' })
        expect(messages[1]._getType()).toBe('tool')
        expect(messages[1].content).toContain('Expected number')
        expect(messages[1].content).not.toContain(invalidValue)
        expect(llmNodeInstance.invoke).toHaveBeenCalledTimes(1)
        expect(streamToolCallCompletedEvent.mock.calls[0][1].error).toContain('attempt 1/3')
        expect(streamToolCallCompletedEvent.mock.calls[0][1].toolInput).toEqual({})
        expect(result.usedTools[0].toolInput).toEqual({})
        expect(sseStreamer.streamCalledToolsEvent).toHaveBeenCalledWith('chat-id', [
            {
                toolCallId: 'invalid-1',
                tool: 'weather',
                toolInput: {},
                toolOutput: ''
            }
        ])
        expect(JSON.stringify(sseStreamer.streamCalledToolsEvent.mock.calls)).not.toContain(invalidValue)
        expect(analyticHandlers.onToolStart).not.toHaveBeenCalled()
        expect(analyticHandlers.onToolEnd).not.toHaveBeenCalled()

        delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        streamToolCallCompletedEvent.mockClear()
        await (agentNode as any).handleToolCalls({
            response: new AIMessageChunk({ content: '', tool_calls: [{ id: 'invalid-2', name: 'weather', args: { city: invalidValue } }] }),
            messages: [],
            toolsInstance: [
                {
                    name: 'weather',
                    schema: {
                        safeParse: () => ({
                            success: false,
                            error: { issues: [{ path: ['city'], code: 'invalid_type', expected: 'number' }] }
                        })
                    },
                    call: jest.fn().mockRejectedValue(new ToolInputParsingException('Received tool input did not match expected schema'))
                }
            ],
            sseStreamer,
            chatId: 'chat-id',
            input: 'input',
            options: {},
            abortController: new AbortController(),
            llmNodeInstance: { invoke: jest.fn().mockResolvedValue(new AIMessageChunk('corrected without events')) },
            isStreamable: false,
            isLastNode: false,
            iterationContext: {}
        })
        expect(streamToolCallCompletedEvent).not.toHaveBeenCalled()

        if (oldValue === undefined) delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        else process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = oldValue
    })

    it('redacts validation arguments when used tools are streamed after a later failure', async () => {
        const agentNode = new AgentAgentflow()
        const invalidValue = 'do-not-leak-this'
        const streamUsedToolsEvent = jest.fn()
        const sseStreamer = {
            streamCalledToolsEvent: jest.fn(),
            streamToolCallCompletedEvent: jest.fn(),
            streamUsedToolsEvent
        }
        const consoleError = jest.spyOn(console, 'error').mockImplementation()

        await expect(
            invokeToolCalls(
                agentNode,
                new AIMessageChunk({
                    content: '',
                    tool_calls: [
                        { id: 'invalid-1', name: 'invalid', args: { value: invalidValue } },
                        { id: 'failed-1', name: 'failed', args: { value: 'safe' } }
                    ]
                }),
                [
                    {
                        name: 'invalid',
                        schema: {
                            safeParse: () => ({
                                success: false,
                                error: { issues: [{ path: ['value'], code: 'invalid_type', expected: 'number' }] }
                            })
                        },
                        call: jest
                            .fn()
                            .mockRejectedValue(
                                new ToolInputParsingException(
                                    'Received tool input did not match expected schema',
                                    JSON.stringify({ value: invalidValue })
                                )
                            )
                    },
                    { name: 'failed', call: jest.fn().mockRejectedValue(new Error('tool failed')) }
                ],
                sseStreamer
            )
        ).rejects.toThrow('tool failed')

        expect(streamUsedToolsEvent).toHaveBeenCalledWith(
            'chat-id',
            expect.arrayContaining([expect.objectContaining({ tool: 'invalid', toolInput: {} })])
        )
        expect(JSON.stringify(streamUsedToolsEvent.mock.calls)).not.toContain(invalidValue)
        consoleError.mockRestore()
    })

    it.each([
        [
            'CustomTool',
            () =>
                new CustomTool({
                    name: 'custom_tool',
                    description: 'custom tool',
                    code: '',
                    schema: z.object({ count: z.number() })
                })
        ],
        [
            'OpenAPIToolkit',
            () =>
                new OpenAPITool({
                    name: 'openapi_tool',
                    description: 'OpenAPI tool',
                    schema: z.object({ count: z.number() }),
                    baseUrl: 'https://example.com',
                    method: 'GET',
                    headers: {}
                })
        ]
    ])('recovers from schema failures thrown by the real %s implementation', async (_name, createTool) => {
        const agentNode = new AgentAgentflow()
        const tool = createTool()
        const messages: any[] = []
        const llmNodeInstance = { invoke: jest.fn().mockResolvedValue(new AIMessageChunk('corrected')) }

        await (agentNode as any).handleToolCalls({
            response: new AIMessageChunk({ content: '', tool_calls: [{ id: 'invalid-real', name: tool.name, args: {} }] }),
            messages,
            toolsInstance: [tool],
            chatId: 'chat-id',
            input: 'input',
            options: {},
            abortController: new AbortController(),
            llmNodeInstance,
            isStreamable: false,
            isLastNode: false,
            iterationContext: {}
        })

        expect(messages[1]).toMatchObject({ status: 'error', tool_call_id: 'invalid-real', name: tool.name })
        expect(llmNodeInstance.invoke).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['missing required property', { path: ['city'], code: 'invalid_type', expected: 'string' }, {}, '$.city', 'missing'],
        ['wrong type', { path: ['days'], code: 'invalid_type', expected: 'number' }, { days: 'two' }, '$.days', 'string'],
        ['range violation', { path: ['days'], code: 'too_small', minimum: 1 }, { days: 0 }, '$.days', 'number'],
        ['unknown property', { path: [], code: 'unrecognized_keys', keys: ['extra'] }, { extra: 'secret' }, '$.extra', 'string']
    ])('creates sanitized Zod diagnostics for %s', (_name, issue, args, path, receivedType) => {
        const agentNode = new AgentAgentflow()
        const diagnostic = (agentNode as any).formatToolInputValidationFailure(
            { id: 'call-1', name: 'weather', args },
            { schema: { safeParse: () => ({ success: false, error: { issues: [issue] } }) } }
        )

        expect(diagnostic.issues[0]).toMatchObject({ path, receivedType })
        expect((agentNode as any).toolInputValidationMessage(diagnostic, 1, 3)).not.toContain('secret')
    })

    it('does not forward custom or unknown Zod issue messages', () => {
        const agentNode = new AgentAgentflow()
        const rejectedValue = 'do-not-leak-this'

        for (const issue of [
            { path: ['value'], code: 'custom', message: `Rejected value: ${rejectedValue}` },
            { path: ['value'], code: 'future_issue', message: `Invalid ${rejectedValue}` }
        ]) {
            const diagnostic = (agentNode as any).formatToolInputValidationFailure(
                { id: 'call-1', name: 'custom', args: { value: rejectedValue } },
                { schema: { safeParse: () => ({ success: false, error: { issues: [issue] } }) } }
            )
            const modelFeedback = (agentNode as any).toolInputValidationMessage(diagnostic, 1, 1)
            const terminalError = (agentNode as any).toolInputValidationExhaustedError([diagnostic], { maxRetries: 0, roundsUsed: 1 })

            expect(diagnostic.issues[0].expected).toBe('the tool input schema')
            expect(modelFeedback).not.toContain(rejectedValue)
            expect(terminalError.message).not.toContain(rejectedValue)
        }
    })

    it.each([
        ['missing required property', { topK: 5 }, '$.query', 'missing', 'required property'],
        ['wrong type', { query: 'secret', topK: '5' }, '$.topK', 'string', 'integer'],
        ['range violation', { query: 'secret', topK: 21 }, '$.topK', 'number', 'maximum 20'],
        ['unknown property', { query: 'secret', unexpected: true }, '$.unexpected', 'boolean', 'no additional properties']
    ])('creates sanitized MCP JSON Schema diagnostics for %s', (_name, args, path, receivedType, expected) => {
        const agentNode = new AgentAgentflow()
        const diagnostic = (agentNode as any).formatToolInputValidationFailure(
            { id: 'call-1', name: 'search', args },
            {
                schema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', minLength: 1 },
                        topK: { type: 'integer', minimum: 1, maximum: 20 }
                    },
                    required: ['query'],
                    additionalProperties: false
                }
            }
        )

        expect(diagnostic.issues).toContainEqual(expect.objectContaining({ path, receivedType, expected }))
        expect(JSON.stringify(diagnostic)).not.toContain('secret')
    })

    it.each([
        [
            '$ref',
            { $defs: { positive: { type: 'number', minimum: 1 } }, type: 'object', properties: { value: { $ref: '#/$defs/positive' } } },
            { value: 0 },
            '$.value',
            'minimum'
        ],
        [
            'anyOf',
            { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
            { value: true },
            '$.value',
            'anyOf'
        ],
        [
            'oneOf',
            {
                type: 'object',
                properties: {
                    value: {
                        oneOf: [
                            { type: 'number', minimum: 0 },
                            { type: 'number', maximum: 10 }
                        ]
                    }
                }
            },
            { value: 5 },
            '$.value',
            'oneOf'
        ],
        [
            'allOf',
            { type: 'object', properties: { value: { allOf: [{ type: 'string' }, { minLength: 20 }] } } },
            { value: 'secret' },
            '$.value',
            'allOf'
        ],
        [
            'exclusiveMinimum',
            { type: 'object', properties: { value: { type: 'number', exclusiveMinimum: 1 } } },
            { value: 1 },
            '$.value',
            'exclusiveMinimum'
        ],
        [
            'exclusiveMaximum',
            { type: 'object', properties: { value: { type: 'number', exclusiveMaximum: 1 } } },
            { value: 1 },
            '$.value',
            'exclusiveMaximum'
        ],
        [
            'pattern',
            { type: 'object', properties: { value: { type: 'string', pattern: '^allowed$' } } },
            { value: 'secret' },
            '$.value',
            'pattern'
        ],
        ['const', { type: 'object', properties: { value: { const: 'allowed' } } }, { value: 'secret' }, '$.value', 'const']
    ])('uses validator paths and keywords for JSON Schema %s failures', (_name, schema, args, path, keyword) => {
        const agentNode = new AgentAgentflow()
        const diagnostic = (agentNode as any).formatToolInputValidationFailure({ id: 'call-1', name: 'schema_tool', args }, { schema })

        expect(diagnostic.issues).toContainEqual(expect.objectContaining({ path, keyword }))
        if (keyword === 'minimum') {
            expect(diagnostic.issues).toContainEqual(expect.objectContaining({ path, keyword, expected: 'minimum 1' }))
        }
        expect(JSON.stringify(diagnostic)).not.toContain('secret')
    })

    it('throws structured sanitized diagnostics when validation retries are disabled', async () => {
        const agentNode = new AgentAgentflow()
        const sseStreamer = { streamCalledToolsEvent: jest.fn(), streamToolCallCompletedEvent: jest.fn() }
        const oldValue = process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT

        await expect(
            (agentNode as any).handleToolCalls({
                response: new AIMessageChunk({ content: '', tool_calls: [{ id: 'invalid-1', name: 'weather', args: { city: 'secret' } }] }),
                messages: [],
                toolsInstance: [
                    {
                        name: 'weather',
                        schema: { safeParse: () => ({ success: false, error: { issues: [{ path: ['city'], expected: 'number' }] } }) },
                        call: jest
                            .fn()
                            .mockRejectedValue(new ToolInputParsingException('Received tool input did not match expected schema'))
                    }
                ],
                sseStreamer,
                chatId: 'chat-id',
                input: 'input',
                options: {},
                abortController: new AbortController(),
                llmNodeInstance: { invoke: jest.fn() },
                isStreamable: false,
                isLastNode: false,
                iterationContext: {},
                validationRetryState: { maxRetries: 0, roundsUsed: 0 }
            })
        ).rejects.toThrow('TOOL_INPUT_SCHEMA_VALIDATION_FAILED')
        expect(sseStreamer.streamToolCallCompletedEvent).not.toHaveBeenCalled()
        if (oldValue === undefined) delete process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT
        else process.env.ENABLE_TOOL_CALL_COMPLETED_EVENT = oldValue
    })

    it('exhausts exactly two correction rounds and never includes argument values in the terminal error', async () => {
        const agentNode = new AgentAgentflow()
        const invalidCall = (id: string) =>
            new AIMessageChunk({
                content: '',
                tool_calls: [{ id, name: 'search', args: { query: 'do-not-leak-this', topK: '5' } }]
            })
        const tool = {
            name: 'search',
            schema: {
                type: 'object',
                properties: { query: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 20 } },
                required: ['query'],
                additionalProperties: false
            },
            call: jest.fn().mockRejectedValue(new ToolInputParsingException('Received tool input did not match expected schema'))
        }
        const llmNodeInstance = {
            invoke: jest.fn().mockResolvedValueOnce(invalidCall('invalid-2')).mockResolvedValueOnce(invalidCall('invalid-3'))
        }

        let terminalError: Error | undefined
        try {
            await (agentNode as any).handleToolCalls({
                response: invalidCall('invalid-1'),
                messages: [],
                toolsInstance: [tool],
                chatId: 'chat-id',
                input: 'input',
                options: {},
                abortController: new AbortController(),
                llmNodeInstance,
                isStreamable: false,
                isLastNode: false,
                iterationContext: {},
                validationRetryState: { maxRetries: 2, roundsUsed: 0 }
            })
        } catch (error) {
            terminalError = error as Error
        }

        expect(tool.call).not.toHaveBeenCalled()
        expect(llmNodeInstance.invoke).toHaveBeenCalledTimes(2)
        expect(terminalError?.message).toContain('TOOL_INPUT_SCHEMA_VALIDATION_FAILED')
        expect(terminalError?.message).toContain('"attempt":3')
        expect(terminalError?.message).toContain('"maxAttempts":3')
        expect(terminalError?.message).toContain('"toolCallId":"invalid-3"')
        expect(terminalError?.message).not.toContain('do-not-leak-this')
    })

    it('counts multiple validation failures in the same model response as one correction round', async () => {
        const agentNode = new AgentAgentflow()
        const retryState = { maxRetries: 2, roundsUsed: 0 }
        const messages: any[] = []
        const invalidTool = (name: string) => ({
            name,
            schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
            call: jest.fn().mockRejectedValue(new ToolInputParsingException('Received tool input did not match expected schema'))
        })

        await (agentNode as any).handleToolCalls({
            response: new AIMessageChunk({
                content: '',
                tool_calls: [
                    { id: 'first-id', name: 'first', args: { count: '1' } },
                    { id: 'second-id', name: 'second', args: { count: '2' } }
                ]
            }),
            messages,
            toolsInstance: [invalidTool('first'), invalidTool('second')],
            chatId: 'chat-id',
            input: 'input',
            options: {},
            abortController: new AbortController(),
            llmNodeInstance: { invoke: jest.fn().mockResolvedValue(new AIMessageChunk('done')) },
            isStreamable: false,
            isLastNode: false,
            iterationContext: {},
            validationRetryState: retryState
        })

        expect(retryState.roundsUsed).toBe(1)
        expect(messages.slice(1).map((message) => message.tool_call_id)).toEqual(['first-id', 'second-id'])
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

    it('recovers from validation errors after an approved human-input tool call', async () => {
        const agentNode = new AgentAgentflow()
        const messages: any[] = []
        const invalidValue = 'do-not-leak-this'
        const analyticHandlers = { onToolStart: jest.fn().mockResolvedValue({ tool: 'trace-id' }), onToolEnd: jest.fn() }
        const checkpoint = new AIMessageChunk({
            content: '',
            tool_calls: [{ id: 'approval-invalid-1', name: 'approved', args: { count: invalidValue } }]
        })
        const llmWithoutToolsBind = {
            invoke: jest.fn().mockResolvedValue(new AIMessageChunk('corrected')),
            bindTools: jest.fn(function () {
                return this
            })
        }

        await (agentNode as any).handleResumedToolCalls({
            humanInput: { type: 'proceed' },
            humanInputAction: { data: { input: { messages: [checkpoint] } } },
            messages,
            toolsInstance: [
                {
                    name: 'approved',
                    schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
                    call: jest
                        .fn()
                        .mockRejectedValue(
                            new ToolInputParsingException(
                                'Received tool input did not match expected schema',
                                JSON.stringify({ count: invalidValue })
                            )
                        )
                }
            ],
            chatId: 'chat-id',
            input: 'input',
            options: { analyticHandlers },
            abortController: new AbortController(),
            llmWithoutToolsBind,
            isStreamable: false,
            isLastNode: false,
            iterationContext: {},
            validationRetryState: { maxRetries: 1, roundsUsed: 0 }
        })

        expect(messages[1]).toMatchObject({ status: 'error', tool_call_id: 'approval-invalid-1', name: 'approved' })
        expect(messages[1]._getType()).toBe('tool')
        expect(llmWithoutToolsBind.invoke).toHaveBeenCalledTimes(1)
        expect(analyticHandlers.onToolStart).not.toHaveBeenCalled()
        expect(analyticHandlers.onToolEnd).not.toHaveBeenCalled()
    })

    it('caps configured tool-input validation retries', () => {
        const agentNode = new AgentAgentflow()

        expect((agentNode as any).getToolInputValidationMaxRetries(1000)).toBe(5)
        expect((agentNode as any).getToolInputValidationMaxRetries(-1)).toBe(0)
        expect((agentNode as any).getToolInputValidationMaxRetries('invalid')).toBe(2)
        expect((agentNode as any).inputs.find((input: any) => input.name === 'agentToolInputValidationMaxRetries').options).toHaveLength(6)
    })
})
