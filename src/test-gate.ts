/**
 * Quick regex test for detectCompletionRequirement.
 */
function detect(task: string): { min: number } | null {
  const m = task.match(
    /(\d+)[^.!?]{0,40}?(?:письм|писем|письмо|email|mess|вакан|позици|объявлен|items|пункт|\bшт\b|элемент)/i
  );
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 2 || n > 50) return null;
  return { min: n };
}

const cases: [string, number | null][] = [
  ["прочитай 10 последних писем во входящих", 10],
  ["10 писем", 10],
  ["зайди в почту, возьми 5 последних emails", 5],
  ["найди 3 вакансии AI-инженера на hh.ru", 3],
  ["найди 3 свежие позиции ML", 3],
  ["посмотри 8 объявлений про аренду", 8],
  ["обработай 15 items из списка", 15],
  ["удали спам", null],
  ["пара писем", null],
  ["100500 писем", null],
];

let ok = 0, bad = 0;
for (const [task, expect] of cases) {
  const got = detect(task);
  const val = got ? got.min : null;
  const pass = val === expect;
  console.log(`${pass ? "[OK]" : "[FAIL]"}  "${task}"  →  ${val}  (expected ${expect})`);
  if (pass) ok++; else bad++;
}
console.log(`\n${ok} ok / ${bad} fail`);
process.exit(bad > 0 ? 1 : 0);
