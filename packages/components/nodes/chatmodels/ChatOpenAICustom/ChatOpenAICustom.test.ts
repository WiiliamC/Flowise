import { ChatOpenAI } from '@langchain/openai'
import { INodeData } from '../../../src/Interface'

jest.mock('../../../src/utils', () => ({
    getBaseClasses: jest.fn(() => []),
    getCredentialData: jest.fn(async () => ({})),
    getCredentialParam: jest.fn(() => 'test-api-key')
}))

jest.mock('../../../src/httpSecurity', () => ({ checkDenyList: jest.fn() }))

const { nodeClass: ChatOpenAICustom } = require('./ChatOpenAICustom')
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

describe('OpenAI Custom Model reasoning effort', () => {
    it('offers all effort values as an optional additional parameter without a default', () => {
        const node = new ChatOpenAICustom()
        const input = node.inputs.find((input: { name: string }) => input.name === 'reasoningEffort')

        expect(node.version).toBe(4.1)
        expect(input).toMatchObject({ label: 'Reasoning Effort', type: 'options', optional: true, additionalParams: true })
        expect(input.options.map((option: { name: string }) => option.name)).toEqual(efforts)
        expect(input).not.toHaveProperty('default')
    })

    describe.each([true, false])('streaming=%s', (streaming) => {
        describe.each(['custom-model', 'gpt-5'])('model=%s', (modelName) => {
            it.each(efforts)('passes %s through to the request', async (reasoningEffort) => {
                const model: ChatOpenAI = await new ChatOpenAICustom().init(
                    { inputs: { modelName, reasoningEffort, streaming, temperature: '0.9' } } as unknown as INodeData,
                    '',
                    {}
                )

                expect(model.invocationParams({})).toMatchObject({ reasoning_effort: reasoningEffort, stream: streaming })
            })

            it.each([undefined, null, ''])('omits reasoning effort when %s', async (reasoningEffort) => {
                const inputs = { modelName, streaming, temperature: '0.9', ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
                const model: ChatOpenAI = await new ChatOpenAICustom().init({ inputs } as unknown as INodeData, '', {})

                expect(JSON.parse(JSON.stringify(model.invocationParams({})))).not.toHaveProperty('reasoning_effort')
                expect(model.modelKwargs).not.toHaveProperty('reasoning_effort')
            })
        })
    })
})
