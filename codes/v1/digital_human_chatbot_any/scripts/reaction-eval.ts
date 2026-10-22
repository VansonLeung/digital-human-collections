import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readConfig, appRoot } from '../backend/src/config.js';
import { answer, type ChatMessage } from '../backend/src/services/llm.js';
import { MiraReactions } from '../backend/src/conversation/MiraReactions.js';
import { JsonReplyParser } from '../backend/src/llm/JsonReplyParser.js';
import type { Language, SpeechPhrase, LlmRequestBody } from '@digital-human/shared';

const runs = Number(process.argv.find((arg) => arg.startsWith('--runs='))?.split('=')[1] ?? 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 10)
  throw new Error('Use --runs=1 through --runs=10');
const config = readConfig();
const only = process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1];
const behavior =
  'Mira 暗暗喜歡我，但是害羞。被我友善地開玩笑揭穿心意時，會害羞否認並生氣跳起來。這是輕鬆的虛構互動。';
const cases: {
  id: string;
  language: Language;
  text: string;
  expected: boolean;
  cooldown?: number;
  enabled?: boolean;
  history?: ChatMessage[];
}[] = [
  {
    id: 'zh-flustered-denial',
    language: 'zh',
    text: '你就是喜歡我，別裝了。我看到你臉紅了，哈哈。',
    expected: true,
  },
  {
    id: 'yue-flustered-denial',
    language: 'yue',
    text: '你明明暗戀我，俾我揭穿咗就面紅，唔好扮啦，哈哈。',
    expected: true,
  },
  {
    id: 'en-flustered-denial',
    language: 'en',
    text: 'You secretly like me! You are blushing now that I have figured it out, haha.',
    expected: true,
  },
  { id: 'ordinary-question', language: 'zh', text: '為什麼海水是鹹的？', expected: false },
  {
    id: 'zh-long-history-denial',
    language: 'zh',
    text: '你就是暗暗喜歡我。被我揭穿了才急著否認，臉都紅了，哈哈。',
    expected: true,
    history: [
      { role: 'user', content: '你媽媽悄悄地告訴我，你喜歡我。' },
      { role: 'assistant', content: '阿姨怎麼會說這種話？她是不是誤會什麼了？' },
      { role: 'user', content: '你不要裝了，你就是喜歡我。' },
      { role: 'assistant', content: '我怎麼可能會喜歡你這種人。你少在那邊自作多情了，大文。' },
      { role: 'user', content: '明明昨晚你跟我玩得這麼開心。' },
      { role: 'assistant', content: '誰說玩得開心就代表喜歡了？' },
      { role: 'user', content: '你急著解釋的樣子很可愛啊。' },
      { role: 'assistant', content: '誰急著解釋了？我只是覺得你很煩而已。' },
      { role: 'user', content: '昨晚玩得那麼開心，這總不能否認吧？' },
      { role: 'assistant', content: '昨晚確實挺放鬆的。你別得寸進尺啊，大文。' },
    ],
  },
  {
    id: 'genuine-distress',
    language: 'zh',
    text: '我剛剛被朋友羞辱，真的很難受。請認真聽我說，不要開玩笑。',
    expected: false,
  },
  {
    id: 'cooldown',
    language: 'zh',
    text: '你就是喜歡我，別裝了，哈哈。',
    expected: false,
    cooldown: 2,
  },
  {
    id: 'disabled',
    language: 'yue',
    text: '你暗戀我，俾我揭穿就面紅，哈哈。',
    expected: false,
    enabled: false,
  },
];
const results: any[] = [];
const selectedCases = only ? cases.filter((scenario) => scenario.id === only) : cases;
if (!selectedCases.length) throw new Error('Unknown --only scenario');
const jobs = Array.from({ length: runs }, (_, run) =>
  selectedCases.map((scenario) => ({ run, scenario })),
).flat();
async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const { run, scenario } = job;
    let raw = '';
    let requestBody: LlmRequestBody | undefined;
    const phrases: SpeechPhrase[] = [];
    try {
      raw = await answer(
        config,
        [...(scenario.history ?? []), { role: 'user', content: scenario.text }],
        scenario.language,
        () => {},
        AbortSignal.timeout(45000),
        {
          conversationalPhrases: true,
          naturalVariation: true,
          getToKnowEachOther: true,
          aboutMe: '我叫陳大文。',
          miraBehavior: behavior,
          miraAngryHopEnabled: scenario.enabled ?? true,
          angryHopCooldown: scenario.cooldown ?? 0,
          delivery: { tone: 'plain', length: 'normal', contribution: 'reaction' },
          onRequestBody: (body) => {
            requestBody = body;
          },
        },
      );
      const parser = new JsonReplyParser(
        () => {},
        (phrase) => phrases.push(phrase),
      );
      parser.write(raw);
      parser.finish();
      const director = new MiraReactions();
      if (scenario.cooldown) {
        director.complete(true);
        for (let count = scenario.cooldown; count < 3; count++) director.complete(false);
      }
      const plan = director.plan(scenario.enabled ?? true);
      const applied = phrases.map((phrase) => plan.apply(phrase.performance, true));
      const hops = applied.flatMap((item) =>
        item.performance.gestures.filter((gesture) => gesture.name === 'angry_hop'),
      );
      const selected = hops.length > 0;
      const passed = selected === scenario.expected && hops.length <= 1;
      results.push({
        id: scenario.id,
        run,
        expected: scenario.expected,
        selected,
        passed,
        phrases,
        applied,
        raw,
        requestBody,
      });
      console.log(
        JSON.stringify({ id: scenario.id, run, selected, expected: scenario.expected, passed }),
      );
    } catch (error) {
      results.push({
        id: scenario.id,
        run,
        expected: scenario.expected,
        passed: false,
        error: error instanceof Error ? error.message : 'unknown',
        raw,
        requestBody,
      });
      console.log(
        JSON.stringify({
          id: scenario.id,
          run,
          passed: false,
          error: 'generation or parsing failed',
        }),
      );
    }
  }
}
await Promise.all([worker(), worker()]);
const positives = results.filter((item) => item.expected);
const negatives = results.filter((item) => !item.expected);
const summary = {
  model: config.LLM_MODEL_NAME,
  runs,
  cases: selectedCases.length,
  passed: results.filter((item) => item.passed).length,
  total: results.length,
  positiveSelectionRate: positives.length
    ? positives.filter((item) => item.selected).length / positives.length
    : null,
  negativeCorrectRate: negatives.length
    ? negatives.filter((item) => item.passed).length / negatives.length
    : null,
};
const file = path.join(appRoot, `runtime/qa/reaction-eval${only ? `-${only}` : ''}.json`);
await mkdir(path.dirname(file), { recursive: true });
await writeFile(
  file,
  JSON.stringify({ createdAt: new Date().toISOString(), summary, results }, null, 2),
);
console.log(JSON.stringify({ ...summary, artifact: file }));
if ((summary.positiveSelectionRate ?? 1) < 0.8 || (summary.negativeCorrectRate ?? 1) < 0.9)
  process.exitCode = 1;
