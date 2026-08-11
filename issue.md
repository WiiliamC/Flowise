# [BUG] AgentFlow V2 Agent aborts the entire turn on recoverable tool input schema errors

## Description

When an AgentFlow V2 Agent generates a tool call whose arguments do not match the selected tool's JSON Schema, the Agent node aborts the entire run with a fatal error:

```text
Error: predictionsServices.buildChatflow - Error in Agent node: Received tool input did not match expected schema
```

The validation failure is not returned to the Agent as a tool error message. As a result, the model has no opportunity to inspect the validation feedback, correct its arguments, and retry the tool call within the same reasoning turn.

This is especially problematic for MCP tools with strict schemas. A transient model-side mistake such as an integer encoded as a string, an out-of-range value, a missing required property, or an additional property terminates the user request even though the error is recoverable.

## Expected behavior

The Agent node should treat tool input validation failures as recoverable tool-call failures:

1. Catch the structured-tool input parsing/validation exception before it escapes the Agent node.
2. Create a tool error message associated with the original `tool_call_id`.
3. Include actionable, sanitized validation details, such as the tool name, property path, expected type or constraint, and received type or value.
4. Return that tool message to the Agent's reasoning loop.
5. Allow the model to correct the arguments and retry, subject to a configurable and bounded retry limit.
6. Terminate the run only when the retry limit is exhausted or the error is classified as non-recoverable.

For example, the Agent should receive feedback similar to:

```text
Tool call failed validation.
Tool: search
Path: topK
Expected: integer between 1 and 20
Received: string
Correct the arguments and call the tool again.
```

## Actual behavior

1. The model emits a tool call with invalid arguments.
2. Tool input validation fails inside the Agent/tool execution boundary.
3. The MCP server is never called.
4. Flowise emits a fatal prediction error containing only the generic schema-mismatch message.
5. The streaming response ends without a completed assistant answer.
6. The invalid arguments and detailed validation issues are not available in the emitted error or downstream trace, which prevents identifying the offending tool field after the fact.

## Steps to reproduce

1. Create an AgentFlow V2 canvas with a Start node followed by an Agent node.
2. Configure the Agent with an OpenAI-compatible custom chat model that supports tool calling.
3. Attach a Custom MCP tool exposing a strict input schema, for example:

    ```json
    {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "minLength": 1
            },
            "topK": {
                "type": "integer",
                "minimum": 1,
                "maximum": 20,
                "default": 5
            }
        },
        "required": ["query"],
        "additionalProperties": false
    }
    ```

4. Cause the model to emit a tool call that violates the schema, for example one of:

    ```json
    { "query": "example", "topK": "5" }
    ```

    ```json
    { "query": "example", "topK": 5, "unexpected": true }
    ```

5. Execute the flow through the streaming Prediction API.

## Reproduction result

The stream emits a fatal error equivalent to:

```text
Error in Agent node: Received tool input did not match expected schema
```

The Agent does not receive a tool result, does not retry with corrected arguments, and does not produce a final response.

In repeated evaluation runs using the same dataset, valid tool arguments complete normally while an occasional invalid tool call fails the entire dataset item. This confirms that the downstream MCP service and its business operation are healthy; the failure occurs before MCP dispatch.

## Environment

-   Deployment: self-hosted Flowise
-   Flow type: AgentFlow V2
-   Agent component version reported by the node catalog: `3.2`
-   Tool component: Custom MCP
-   Custom MCP component version reported by the node catalog: `1.1`
-   Model integration: OpenAI-compatible Custom Model
-   Prediction mode: streaming
-   Agent memory: enabled
-   Flowise application version: unavailable because the running instance does not expose it through the inspected API

No credentials, private endpoints, prompts, flow identifiers, or raw FlowData are included in this report.

## Impact

-   A recoverable model formatting mistake becomes a user-visible request failure.
-   Long-running, multi-step Agent turns lose all progress accumulated before the invalid tool call.
-   Batch evaluations become flaky because identical inputs may succeed or fail depending on the generated tool arguments.
-   Operators cannot determine which tool or property failed because the generic error omits validation issues and the raw tool arguments.
-   Retrying at the HTTP layer is ineffective because the model is not given corrective feedback and may repeat the same invalid call.

## Current configuration gap

The inspected Agent node exposes model, messages, tools, memory, response format, structured output, and flow-state settings. It does not expose an option equivalent to:

-   `handleToolErrors`
-   `continueOnToolError`
-   tool argument correction retries
-   maximum tool validation retry count

AgentFlow V2 supports explicit conditions and loops at the canvas level, but those nodes cannot handle this failure after the Agent node has already thrown and terminated execution. The validation exception must first be converted into data or a tool message at the Agent/tool boundary.

## Suggested remediation

Handle input-schema failures in the Agent node's tool execution layer rather than at the Prediction API boundary.

Conceptually:

```ts
try {
    return await tool.invoke(toolCall.args)
} catch (error) {
    if (isToolInputValidationError(error)) {
        return new ToolMessage({
            tool_call_id: toolCall.id,
            status: 'error',
            content: formatSanitizedValidationError(tool.name, error)
        })
    }
    throw error
}
```

The Agent loop should then consume the error `ToolMessage` and decide whether to issue a corrected tool call. A bounded retry counter should prevent infinite correction loops.

This behavior should not loosen or bypass the tool schema. The schema remains the source of truth; the change only makes validation failure observable and recoverable by the Agent.

## Observability improvement

If recovery is disabled or ultimately fails, the terminal error should include sanitized structured diagnostics:

```json
{
    "code": "TOOL_INPUT_SCHEMA_VALIDATION_FAILED",
    "tool": "search",
    "toolCallId": "...",
    "issues": [
        {
            "path": ["topK"],
            "expected": "integer between 1 and 20",
            "receivedType": "string"
        }
    ],
    "attempt": 1,
    "maxAttempts": 2
}
```

Sensitive values should be omitted or redacted. Tool name, property path, constraints, received type, and retry counters are generally sufficient for diagnosis.

## Acceptance criteria

-   [ ] A malformed tool call does not immediately terminate the Agent turn when correction retries remain.
-   [ ] The validation failure is returned as a tool message with the original `tool_call_id`.
-   [ ] The Agent can emit corrected arguments and successfully invoke the tool in the same run.
-   [ ] Retry count is bounded and configurable, with a safe default.
-   [ ] Non-validation exceptions retain their existing failure semantics unless explicitly classified as recoverable.
-   [ ] Streaming clients receive tool-error/retry progress without receiving a fatal error during a recoverable attempt.
-   [ ] When retries are exhausted, the final error identifies the tool and validation paths without exposing secrets.
-   [ ] Regression tests cover missing required properties, wrong primitive types, out-of-range values, unknown properties, successful correction, and retry exhaustion.

## Related documentation

-   [Flowise AgentFlow V2 documentation](https://docs.flowiseai.com/using-flowise/agentflowv2)
-   [Flowise SQL Agent example using validation and bounded loop retries](https://docs.flowiseai.com/tutorials/sql-agent)
