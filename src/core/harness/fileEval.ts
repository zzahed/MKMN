/**
 * The file eval: the Word and Excel pipelines (a template filled in, or the file written freely when no template fits) run end to
 * end against scripted model personas, each one a habit of a small local model that made files look unfinished: a document of
 * empty headings, a document that says the same thing twice, a template filled with a title and nothing else, a sheet whose
 * formula cannot run and whose total is typed by hand. A persona answers from what the app asked it (it follows the feedback,
 * as a model does), never from a network. The file is scored by its rubric (src/core/fileQuality.ts) and must reach QUALITY_BAR.
 *
 * Web pages are scored by the same rubric family (pageQuality); their end-to-end persona waits for the site renderer to load
 * under the test runner (it needs the page editor's dependencies installed).
 */
import type { ChatEvent, ChatMessage, ChatStats } from "../../shared/types";
import { makeFromTemplate } from "../templates/build";
import type { Session } from "../build";
import { artifactsIn } from "../artifacts";
import { fileQuality, type FileKind } from "../fileQuality";
import { QUALITY_BAR } from "./quality";
import type { CaseResult } from "./evals";

export interface FileScenario {
  id: string;
  description: string;
  kind: FileKind;
  request: string;
  /** The persona's reply to one call: the session id names the step, `asked` is the app's last message, `told` is true once the app named problems. */
  reply: (sid: string, asked: string, told: boolean) => string;
}

const stats: ChatStats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };
const TOLD = /problems|fix them/i;

const FULL_REPORT = [
  "# Q3 Support Review", "",
  "## Summary", "Ticket volume rose 18% in the quarter while the median first reply fell from nine hours to four after the new triage rota started in July.", "",
  "## Volume", "Most of the new tickets came from the billing page after the September price change, which confused customers on annual plans.", "",
  "## Response", "Two people now answer first replies every morning, which halved the backlog within three weeks and cut reopen rates.", "",
  "## Recommendations", "- Rewrite the billing FAQ in plain words", "- Add a second evening shift during launches",
].join("\n");

export const FILE_SCENARIOS: FileScenario[] = [
  {
    id: "docx-shell",
    description: "writes a document of empty headings until told it says nothing",
    kind: "docx",
    request: "write a quarterly review memo for the support team, as a Word document, with sections on volume and response times",
    reply: (sid, _asked, told) => (/:x:free:docx/.test(sid) ? (told ? FULL_REPORT : "# Q3 Support Review\n\n## Summary\n\n## Volume\n\n## Response\n") : sid.endsWith(":template") ? '{"template":"none"}' : "Done."),
  },
  {
    id: "docx-repeats",
    description: "writes a document that says the same paragraph twice until told",
    kind: "docx",
    request: "write a quarterly review memo for the support team, as a Word document",
    reply: (sid, _asked, told) => {
      if (!/:x:free:docx/.test(sid)) return sid.endsWith(":template") ? '{"template":"none"}' : "Done.";
      const twice = "Ticket volume rose sharply this quarter because of the billing page change in September.";
      return told ? FULL_REPORT : `# Q3 Support Review\n\n## Summary\n${twice} Median replies took four hours.\n\n## Volume\n${twice} Median replies took four hours.\n\n## Response\nThe new rota halved the backlog within three weeks and cut reopen rates for annual customers.`;
    },
  },
  {
    id: "docx-template-title-only",
    description: "fills a report template with a title and nothing else until told the document says nothing",
    kind: "docx",
    request: "write a Word report on our Q3 support numbers: volume up 18%, median first reply down from 9 to 4 hours thanks to the new triage rota",
    reply: (sid, _asked, told) => {
      if (sid.endsWith(":template")) return '{"template":"report"}';
      if (/:fill:/.test(sid)) return told
        ? JSON.stringify({ language: "en", title: "Q3 Support Review", summary: "Ticket volume rose 18% in the quarter while the median first reply fell from nine to four hours after the new triage rota.", sections: [{ heading: "Volume", text: "The rise came mostly from the billing page after the September price change, which confused customers on annual plans." }, { heading: "Response", text: "Two people now answer first replies each morning, which halved the backlog within three weeks." }], conclusion: "Keep the rota and rewrite the billing page copy before the next price change.", recommendations: ["Rewrite the billing FAQ", "Add an evening shift during launches"] })
        : JSON.stringify({ language: "en", title: "Q3 Support Review" });
      return "Done.";
    },
  },
  {
    id: "xlsx-broken-formula",
    description: "writes a sheet whose formula cannot run and whose total is typed by hand, until told",
    kind: "xlsx",
    request: "make a spreadsheet of our office supplies with a total cost",
    reply: (sid, _asked, told) => {
      if (!/:x:free:xlsx/.test(sid)) return sid.endsWith(":template") ? '{"template":"none"}' : "Done.";
      return told
        ? "## Supplies\n| Item | Qty | Unit price | Cost |\n|---|---|---|---|\n| Paper | 10 | 4.5 | =B2*C2 |\n| Toner | 2 | 60 | =B3*C3 |\n| Pens | 30 | 0.8 | =B4*C4 |\n| Total | | | =SUM(D2:D4) |"
        : "## Supplies\n| Item | Qty | Unit price | Cost |\n|---|---|---|---|\n| Paper | 10 | 4.5 | =B2*C2 |\n| Toner | 2 | 60 | =B3*C3) |\n| Pens | 30 | 0.8 | =B4*C4 |\n| Total | | | 189 |";
    },
  },
];

/** Run one scenario through the Word/Excel pipeline and score the file it made. */
export async function evaluateFileScenario(s: FileScenario): Promise<CaseResult> {
  const stream: Session = async function* (sid: string, messages: ChatMessage[]): AsyncGenerator<ChatEvent> {
    const asked = String(messages[messages.length - 1]?.content ?? "");
    yield { id: "eval", type: "answer", text: s.reply(sid, asked, TOLD.test(asked)) };
    yield { id: "eval", type: "done", stats };
  };
  const gen = makeFromTemplate({ id: "eval", messages: [{ role: "user", content: s.request }], stream, drawEveryMs: 0 });
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  const text = r.value.handled ? r.value.text : "";
  const file = artifactsIn(text).filter((a) => (s.kind === "html" ? a.kind === "html" : a.kind === s.kind)).pop();
  if (!file) return { id: s.id, pass: false, metrics: { quality: 0 }, detail: "no file was made" };
  const q = fileQuality(s.kind, file.content);
  const pass = q.score >= QUALITY_BAR;
  return { id: s.id, pass, metrics: { quality: q.score }, detail: pass ? undefined : `score ${q.score}: ${q.failed.map((f) => `${f.id} (${f.note})`).join("; ")}` };
}
