#!/usr/bin/env ts-node
import * as fs from 'fs';
import {
  runZ0ChoiceExperiment,
  runZ0NoulExperiment,
} from '../emma/z0Adapter';

async function main() {
  const output = process.argv[2] || '/tmp/z0-typesafe-protocol.json';

  const choice = {
    operation_id: 'sdk-choice-op-1',
    decision_id: 'report_type_v1',
    state: { filename: 'q3.html', excerpt: 'ROAS CTR spend' },
    instructions: 'Classify the report.',
    options: {
      creative: 'Marketing creative',
      performance: 'Paid media metrics',
      research: 'General research',
    },
    allow_remote: true,
  };
  const choiceOptions = { scopeId: 'sdk-protocol-choice' };
  const choiceFirst: any = await runZ0ChoiceExperiment(choice, choiceOptions);
  const choiceReplay: any = await runZ0ChoiceExperiment(choice, choiceOptions);
  const choiceMutation: any = await runZ0ChoiceExperiment(
    {
      ...choice,
      options: {
        ...choice.options,
        research: 'Mutated definition under identical logical operation',
      },
    },
    choiceOptions,
  );

  const noul = {
    operation_id: 'sdk-noul-op-1',
    decision_id: 'stop_request_v1',
    state: { latest_user_message: 'stop here please' },
    proposition: 'Did the user explicitly ask the agent to stop or pause now?',
    allow_remote: true,
  };
  const noulOptions = { scopeId: 'sdk-protocol-noul' };
  const noulFirst: any = await runZ0NoulExperiment(noul, noulOptions);
  const noulReplay: any = await runZ0NoulExperiment(noul, noulOptions);

  const result = {
    schema: 'agentweb.z0_typesafe_protocol_e2e.v1',
    choice: {
      first: choiceFirst,
      replay: choiceReplay,
      mutation: choiceMutation,
    },
    noul: {
      first: noulFirst,
      replay: noulReplay,
    },
  };
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');

  if (!choiceFirst.ok || choiceFirst.applied !== false) throw new Error('choice first call failed');
  if (choiceFirst.output?.label !== 'performance') throw new Error('choice label mismatch');
  if (choiceFirst.output?.model !== 'jev-1.13.0') throw new Error('choice model mismatch');
  if (choiceReplay.replayed !== true) throw new Error('choice replay missing');
  if (choiceMutation.ok !== false || choiceMutation.reason !== 'http_error') {
    throw new Error('choice mutation was not rejected at authority boundary');
  }

  if (!noulFirst.ok || noulFirst.applied !== false) throw new Error('noul first call failed');
  if (noulFirst.output?.probability !== 0.93) throw new Error('noul probability mismatch');
  if (noulFirst.output?.model !== 'jev-1.13.0') throw new Error('noul model mismatch');
  if (noulReplay.replayed !== true) throw new Error('noul replay missing');

  process.stderr.write('z0 TypeSafe SDK protocol fixture passed\n');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
