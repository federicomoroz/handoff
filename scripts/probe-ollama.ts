/**
 * Local backend probe.
 *
 * It replaces the paid smoke test a cloud-API project would need: it checks that Ollama
 * is up, that the model exists, and that it does tool calling in the shape the adapter
 * expects. It costs nothing and answers the one question documentation cannot.
 *
 * It uses the REAL `DECISION_TOOL`, not a copy: a probe whose job is to check the model
 * answers in the shape the adapter expects is worthless if it validates against a
 * hand-written duplicate that can drift.
 *
 *   npx tsx scripts/probe-ollama.ts
 */
import { buildOllamaLlm, OLLAMA_MODEL, OLLAMA_URL } from '../src/adapters/secondary/ollama-llm';
import { DECISION_TOOL } from '../src/adapters/secondary/decision-tool';

async function main(): Promise<void> {
  console.log(`url     : ${OLLAMA_URL}`);
  console.log(`model   : ${OLLAMA_MODEL}\n`);

  const think = process.env['HANDOFF_THINK'];
  const llm = buildOllamaLlm(think === undefined ? {} : { think: think === '1' });
  const startedAt = Date.now();

  const response = await llm.complete({
    system:
      'You are an e-commerce incident triage agent. You always answer by calling the ' +
      'record_decision tool. You never answer in free text.',
    messages: [
      {
        role: 'user',
        content:
          'Incident: order FC-10241 shows as delivered two days ago and the customer says ' +
          'the box arrived soaked. The total is 48290 pesos and the customer has no prior ' +
          'claims. Record the decision.',
      },
    ],
    tools: [DECISION_TOOL],
    maxTokens: 800,
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`served  : ${response.model}`);
  console.log(`stop    : ${response.stopReason}`);
  console.log(`tokens  : ${response.usage.inputTokens} in / ${response.usage.outputTokens} out`);
  console.log(`elapsed : ${elapsed}s\n`);

  if (response.toolCalls.length === 0) {
    console.log('NO TOOL CALL. Text returned:');
    console.log(response.text.slice(0, 500));
    console.log('\n-> The model did not call the tool. Try another model.');
    process.exitCode = 1;
    return;
  }

  for (const call of response.toolCalls) {
    console.log(`tool    : ${call.name}`);
    console.log(`input   : ${JSON.stringify(call.input, null, 2)}`);
  }
  console.log('\n-> Tool calling works: the local backend is usable.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
