/** What every template library shares: the language, the words that stay fixed in a document, the shape of a template. */
import { mdCell } from "../escape";

export const LANGS = ["en"] as const;
export type Lang = (typeof LANGS)[number];

/** Fixed words of a document template, in English. */
const L: Record<string, string> = {
  summary: "Summary", contents: "Contents", introduction: "Introduction",
  conclusion: "Conclusion", recommendations: "Recommendations", sources: "Sources",
  date: "Date", to: "To", from: "From", subject: "Subject", cc: "Cc", attachments: "Attachments",
  regards: "Sincerely", signature: "Signature", objectives: "Objectives",
  materials: "Materials", steps: "Steps", assessment: "Assessment", homework: "Homework",
  agenda: "Agenda", attendees: "Attendees", absent: "Absent",
  decisions: "Decisions", actions: "Actions", owner: "Owner", due: "Due",
  task: "Task", discussion: "Discussion", nextMeeting: "Next meeting",
  place: "Place", time: "Time", duration: "Duration", level: "Level",
  ingredients: "Ingredients", preparation: "Preparation", tips: "Tips", servings: "Servings",
  experience: "Experience", education: "Education", skills: "Skills",
  languages: "Languages", projects: "Projects", certificates: "Certifications", interests: "Interests",
  profile: "Profile", contact: "Contact", invoice: "Invoice", quote: "Quote",
  number: "Number", dueDate: "Due date", description: "Description",
  qty: "Qty", unitPrice: "Unit price", amount: "Amount",
  subtotal: "Subtotal", tax: "Tax", total: "Total", terms: "Terms", payment: "Payment",
  client: "Client", scope: "Scope", timeline: "Timeline", pricing: "Pricing",
  phase: "Phase", deliverable: "Deliverable", problem: "Problem", solution: "Solution",
  nextSteps: "Next steps", risks: "Risks", risk: "Risk", impact: "Impact",
  mitigation: "Mitigation", milestones: "Milestones", budget: "Budget", stakeholders: "Stakeholders",
  goals: "Goals", nonGoals: "Non-goals", users: "Users", requirements: "Requirements",
  priority: "Priority", metrics: "Metrics", openQuestions: "Open questions",
  purpose: "Purpose", roles: "Roles", revision: "Revision history",
  about: "About", pressContact: "Press contact", parties: "Parties", clauses: "Clauses",
  signatures: "Signatures", notes: "Notes", keyTerms: "Key terms", term: "Term",
  definition: "Definition", day: "Day", program: "Program", speaker: "Speaker",
  session: "Session", itinerary: "Itinerary", overview: "Overview", background: "Background",
  findings: "Findings", analysis: "Analysis", appendix: "Appendix", abstract: "Abstract",
  keywords: "Keywords", references: "References", name: "Name", role: "Role",
  status: "Status", author: "Author", edition: "Edition", events: "Upcoming events",
  mainPoints: "Key points", options: "Options", pros: "Pros", cons: "Cons",
  facts: "Facts", causes: "Causes", lessons: "Lessons learned", location: "Location",
  venue: "Venue", price: "Price", validity: "Valid until", questions: "Questions"
};
const TABLE = new Map(Object.entries(L).map(([k, v]) => [k, v.split("|")]));
export const label = (lang: Lang, key: string): string => TABLE.get(key)?.[LANGS.indexOf(lang)] ?? TABLE.get(key)?.[0] ?? key;

/** The language of a request: templates write English. */
export function langOf(_text: string): Lang {
  return "en";
}

export type TemplateKind = "docx" | "xlsx" | "site" | "tool";
export interface TemplateInfo { id: string; kind: TemplateKind; name: string; summary: string; words: RegExp }
export interface Rendered { source: string; title: string }
export interface Template extends TemplateInfo {
  /** More instructions for the model that fills this template, built when the prompt is written: the icon names a site may use are only known once the icon table has loaded (see `loadIcons`). */
  hint?: () => string;
  /** JSON schema of the data the model fills in (always closed: no field the template does not know). */
  schema: object;
  /** What is wrong with the data, in words the model can act on. */
  problems(data: unknown): string[];
  /** `live`: the data is still being written, so only what is there is drawn (no empty rows or sheets waiting to be filled). */
  render(data: unknown, opts?: { live?: boolean }): Rendered;
}
export const schemaStr = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
export const schemaStrs = (description?: string) => ({ type: "array", items: { type: "string" }, maxItems: 30, ...(description ? { description } : {}) });
export const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
export const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(asText).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);
export const asRows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
export const esc = (s: string) => mdCell(s).replace(/\r?\n/g, " ");
