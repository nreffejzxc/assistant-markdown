/**
 * AI-4 — the assistant's answer, parsed into structure.
 *
 * WHY THIS EXISTS. The chat bubble renders inside a React Native `<Text>`, which
 * is not a Markdown renderer. AI-2 handled that by REMOVING the inline markers a
 * model emits (`**bold**`, backticks, heading hashes) — a decision that was
 * correct for prose and is still correct for those markers, because they are
 * noise once read as text.
 *
 * It does not work for a table. In `| Product | SKU |` the pipes are
 * load-bearing: strip them and the rows collapse into unreadable prose, keep them
 * and the screen shows punctuation. AI-2 kept them, and the 2026-10-13 device run
 * found that **all three** successful answers at catalogue scale were tables
 * (ISS-25, §27BG) — so this was every answer, not an edge case.
 *
 * WHAT IT IS. A small, line-oriented parser for the subset of Markdown this
 * assistant actually emits — measured over every stored answer, not guessed:
 * headings, paragraphs, bullet and numbered lists, pipe tables, fenced code and
 * rules. No dependency, no server call, no prompt change: the model already
 * writes this, and nothing new is asked of it. That is deliberate — a formatting
 * instruction in the system prompt would be paid for on every turn forever, and
 * the readability win here is free.
 *
 * THE TWO INVARIANTS AI-2 ESTABLISHED ARE PRESERVED, because both protect DATA
 * rather than formatting:
 *
 *  * A single underscore is NEVER emphasis. Answers are full of identifiers —
 *    `SKU_123_AB`, `product_code`, `MIN_STOCK_LEVEL` — and an `_emphasis_` rule
 *    would silently corrupt the very facts the assistant exists to report. Only a
 *    doubled `__pair__` is bold.
 *  * Emphasis requires a word boundary. `12 * 3 = 36` is arithmetic, and so is
 *    `4*5*6` — a `*` touching an alphanumeric on the outside is data, not markup.
 *
 * `stripMarkdown` is RETAINED and now has a precise job: it is the residual pass
 * applied to every span this parser does not model, so a marker nobody taught
 * this file about still cannot reach the screen. Belt and braces, one source.
 *
 * ISS-26 (2026-10-14) is that guarantee being exercised by a marker family it had
 * never met: at catalogue scale the model answered a percentage question with a
 * LaTeX formula (`\( \frac{620}{10,000} \times 100 = \mathbf{6.2\%} \)`), which
 * reached the screen as source. `stripLatex` decodes the forms this assistant
 * actually emits — see its own note for the two boundaries that keep it from
 * corrupting data.
 */

/** One run of text with the inline styling it carries. */
export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** One item of a bullet or numbered list. */
export interface ListItem {
  /** The marker as it will be shown — `•`, or the model's own `1.` / `2)`. */
  marker: string;
  spans: Cell;
}

/** One table cell: the inline spans it contains. */
export type Cell = InlineSpan[];

/** One table row: its cells, in column order. */
export type Row = Cell[];

export type Block =
  | { kind: 'heading'; level: number; spans: Cell }
  | { kind: 'paragraph'; spans: Cell }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'table'; header: Row; rows: Row[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

/** A character that can carry meaning next to a marker: letters and digits. */
const WORD = /[A-Za-z0-9]/;

/**
 * The LaTeX symbol commands, as the character each one means.
 *
 * Ordered so a longer command is never shadowed by a shorter prefix, and every
 * one carries a trailing word boundary so `\le` cannot eat the `\leq` beside it
 * (nor `\to` the `\top`).
 */
const LATEX_SYMBOLS: [RegExp, string][] = [
  [/\\times\b/g, '×'],
  [/\\div\b/g, '÷'],
  [/\\cdot\b/g, '·'],
  [/\\leq\b/g, '≤'],
  [/\\le\b/g, '≤'],
  [/\\geq\b/g, '≥'],
  [/\\ge\b/g, '≥'],
  [/\\neq\b/g, '≠'],
  [/\\ne\b/g, '≠'],
  [/\\approx\b/g, '≈'],
  [/\\pm\b/g, '±'],
  [/\\rightarrow\b/g, '→'],
  [/\\to\b/g, '→'],
  [/\\%/g, '%'],
  [/\\\$/g, '$'],
  [/\\&/g, '&'],
  [/\\#/g, '#'],
  [/\\_/g, '_'],
  [/\\\{/g, '{'],
  [/\\\}/g, '}'],
];

/** `\mathbf{x}` and friends carry their argument and nothing else. */
const LATEX_WRAPPERS =
  /\\(?:mathbf|textbf|textit|text|mathrm|mathit|operatorname|mbox|textnormal)\s*\{([^{}]*)\}/g;

/**
 * `\frac{a}{b}` is a division once read as text.
 *
 * A SIDE CARRYING AN OPERATOR KEEPS ITS BRACKETS, and that is a correctness rule
 * rather than a cosmetic one. Measured on the phone during the 2026-10-14 AI-4 device
 * pass: asked what percentage of products were low on stock, the assistant answered
 * `\frac{17 + 5}{113}` — "17 plus 5, over 113" — which the plain `a/b` rule decoded to
 * `17+ 5/113`, a string that reads as `17 + (5/113)` and therefore as a DIFFERENT
 * number from the one the model computed (0.044% instead of 19.5%). `(17+5)/113`
 * cannot be misread, so a side carrying any operator keeps its brackets.
 *
 * THE MULTIPLICATIVE SIDES ARE THE SAME DEFECT, AND WORSE FOR BEING QUIET. `+` and `-`
 * are the ones the phone happened to show, but the bar binds tighter than `×` and `÷`
 * exactly as it does than `+`, so `\frac{1}{2 \times 3}` — one sixth — used to decode to
 * `1/2 × 3`, which reads left to right as one and a half. A wrong number is the failure
 * this module exists to prevent, so the rule covers `+ - − × · ÷ /` and their LaTeX
 * spellings (`\times`, `\cdot`, `\div`, `\pm`, `\mp`) rather than the operators one
 * screenshot happened to show.
 *
 * A SINGLE TERM IS UNTOUCHED, which is what keeps this rule away from the answers already
 * stored: `\frac{620}{10,000}` still decodes to `620/10,000` — the form both the earlier
 * device fixture and the existing cases pin.
 */
const LATEX_FRAC = /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;

/**
 * Anything that would interact with the `/` were the bar dropped for nothing: the
 * arithmetic signs, in the plain and the LaTeX spelling the model uses interchangeably.
 * `\pm` and `\mp` are here for the same reason as `×` — they change what the side is.
 */
const FRACTION_OPERATOR = /[+\-−×·÷\/]|\\times|\\cdot|\\div|\\pm|\\mp/;

/** One side of a fraction, bracketed only when dropping the bar could change its meaning. */
function fractionTerm(side: string): string {
  return FRACTION_OPERATOR.test(side) ? `(${side})` : side;
}

/**
 * Decode the LaTeX this assistant writes into plain, readable text (ISS-26).
 *
 * WHY A DECODER AND NOT A MATHS RENDERER. The measured need is a readable
 * percentage — `620/10,000 × 100 = 6.2%` — not typesetting, and a stacked fraction
 * would mean a dependency and a layout the bubble has no room for. It is also not
 * a prompt change: that would cost tokens on every turn forever and would leave
 * every answer already stored unreadable.
 *
 * THREE BOUNDARIES, ALL DELIBERATE:
 *
 *  * A single `$…$` is NOT a maths delimiter here. A dollar sign in these answers
 *    is currency far more often than it is markup, so treating `$1,200` as a span
 *    would delete a real amount — the same data-corruption failure the underscore
 *    rule exists to prevent. Only the unambiguous `\(…\)`, `\[…\]` and `$$…$$`
 *    forms are stripped.
 *  * An UNRECOGNISED command is LEFT ALONE. Nothing is removed that is not
 *    recognised, because dropping stray backslashes would eat the separator out of
 *    a Windows path (`C:\Users\…`) to tidy up a marker that was never there.
 *  * A SUPERSEDED structural marker becomes brackets, not nothing: `\frac` turns
 *    into a division sign, and a side that carries an operator of its own is wrapped so
 *    the division still means what the model meant. See {@link LATEX_FRAC} for the
 *    device measurement that made this a rule instead of a nicety.
 *
 * Runs once per rendered bubble over a string already in memory, so it costs
 * nothing in tokens and nothing in latency a member can notice.
 */
export function stripLatex(raw: string): string {
  if (!raw || !raw.includes('\\')) return raw;
  let out = String(raw);

  // Wrappers and fractions nest (`\frac{\mathbf{a}}{b}`), so resolve them inward
  // out; the bound stops a pathological input from looping.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    out = out
      .replace(LATEX_WRAPPERS, '$1')
      .replace(
        LATEX_FRAC,
        (_match, numerator: string, denominator: string) =>
          `${fractionTerm(numerator)}/${fractionTerm(denominator)}`,
      );
    if (out === before) break;
  }

  for (const [pattern, replacement] of LATEX_SYMBOLS) out = out.replace(pattern, replacement);

  // Delimiters last, and each consumes the whitespace that hugged it, so removing
  // `\( ` / ` \)` cannot leave a double space behind in the answer.
  return out
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, '$1')
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, '$1')
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, '$1')
    .replace(/\\(?:quad|qquad)\b/g, ' ')
    .replace(/\\[,;:!]/g, '');
}

/**
 * Remove the Markdown markers that are meaningless as plain text (AI-2).
 *
 * This is no longer the whole answer pipeline — AI-4 renders the structure — but
 * it remains the guarantee that nothing unrecognised leaks to the screen. Its
 * documented limits are load-bearing and are pinned by a focused suite:
 * single underscores are never emphasis (identifiers are data), and a lone
 * asterisk counts only when a non-space follows it (`12 * 3 = 36` stays
 * arithmetic).
 *
 * AI-4 ADDED THE WORD BOUNDARY, and it fixed a real defect rather than tidying
 * one. The previous rules had no boundary at all, so any two asterisks enclosing
 * non-space text were emphasis — which silently rewrote `4*5*6` as `456` and
 * `A*B*C` as `ABC`. In an assistant that reports quantities, quietly deleting
 * characters from a multiplication is the worst kind of bug: the answer still
 * looks like an answer. A marker now has to stand apart from a word to count, so
 * ambiguous markup is treated as data — which is the direction to fail in, and
 * the one this function's own reasoning ("the very data the assistant exists to
 * report") always implied.
 */
export function stripMarkdown(raw: string): string {
  if (!raw) return raw;
  return stripLatex(raw)
    // Fenced code: keep the content, drop the fence and any language tag.
    .replace(/```[a-zA-Z0-9]*\r?\n?([\s\S]*?)```/g, (_match, body: string) => String(body).trim())
    // Bold runs first: `**x**` must not be read as an italic wrapping `*x*`.
    // The boundary is `(^|[^A-Za-z0-9])` / `(?![A-Za-z0-9])` rather than a
    // lookbehind, which older Hermes builds do not all support.
    .replace(/(^|[^A-Za-z0-9])\*\*([^*]+)\*\*(?![A-Za-z0-9])/g, '$1$2')
    .replace(/(^|[^A-Za-z0-9_])__([^_]+)__(?![A-Za-z0-9_])/g, '$1$2')
    // Single-asterisk emphasis — see the underscore/asterisk limits above.
    .replace(/(^|[^A-Za-z0-9])\*(\S[^*\n]*?)\*(?![A-Za-z0-9])/g, '$1$2')
    // Inline code spans, whose backticks are the noisiest thing on a phone.
    .replace(/`([^`]+)`/g, '$1')
    // Heading hashes, only when followed by a space, so `#1 selling product` stays.
    .replace(/^#{1,6}\s+/gm, '');
}

/**
 * Split one line of text into styled spans.
 *
 * A single forward scan, so the cost is linear in the line and there is no
 * backtracking regex to blow up on a long answer. Markers are only recognised
 * where they can mean markup: `**`/`__` and `*` must be preceded by a
 * non-alphanumeric character (or start the line) and the closing run must be
 * followed by one, which is what keeps `4*5*6` and `SKU_123_AB` intact.
 */
export function parseInline(raw: string): InlineSpan[] {
  const src = String(raw ?? '');
  const spans: InlineSpan[] = [];
  let buffer = '';
  let i = 0;

  // The residual pass, applied where unmodelled markers actually land: plain
  // text. Everything recognised above became a span of its own, so whatever is
  // still in the buffer is either ordinary prose or a marker this parser does
  // not model — and a marker nobody modelled must not reach the screen.
  const flush = (): void => {
    if (!buffer) return;
    spans.push({ text: stripMarkdown(buffer) });
    buffer = '';
  };

  /** True when a marker at `at` may open — the text before it is not a word. */
  const opens = (at: number): boolean => at === 0 || !WORD.test(src[at - 1]);
  /** True when a marker ending at `at` may close — the text after is not a word. */
  const closes = (at: number): boolean => at + 1 >= src.length || !WORD.test(src[at + 1]);

  while (i < src.length) {
    const ch = src[i];

    // Inline code. Its content is literal data, so nothing inside is parsed.
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        spans.push({ text: src.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    // Bold: `**x**` or `__x__` (the only underscore form that is ever emphasis).
    if ((ch === '*' || ch === '_') && src[i + 1] === ch && opens(i)) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2 && closes(end + 1)) {
        flush();
        spans.push({ text: src.slice(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }

    // Italic: a lone `*` with a non-space after it, closed by one that follows a
    // non-space. `*` is the only carrier — an underscore never is (see above).
    if (ch === '*' && opens(i) && !/\s/.test(src[i + 1] ?? '')) {
      let end = i + 1;
      while (end < src.length && !(src[end] === '*' && !/\s/.test(src[end - 1] ?? ''))) end += 1;
      if (end < src.length && end > i + 1 && closes(end)) {
        flush();
        spans.push({ text: src.slice(i + 1, end), italic: true });
        i = end + 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return spans;
}

/** Cells of one table line, whether or not it carries the optional edge pipes. */
function splitCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell) => cell.trim());
}

/** `|---|:--:|` — a layout instruction, never a row of data. */
function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-') || !trimmed.includes('|')) return false;
  return /^[\s|:-]+$/.test(trimmed);
}

/**
 * Does a block beginning with `|` start here? True when the next line is a
 * separator row, or is itself a pipe row (a table whose separator the model
 * omitted). Used in both places a paragraph must stop, so the two cannot drift.
 */
function startsTable(lines: string[], at: number): boolean {
  if (!lines[at]?.includes('|')) return false;
  const next = lines[at + 1];
  if (!next) return false;
  return isSeparatorRow(next) || (next.includes('|') && next.trim().startsWith('|'));
}

/**
 * A Markdown HARD line break: two or more trailing spaces.
 *
 * The distinction this encodes is not theoretical, and getting it wrong is how
 * AI-4's first version made an answer HARDER to read than the code it replaced.
 * The models put one field per line like this:
 *
 *   **Product:** Pro Cable 1000··        <- the two spaces mean "break here"
 *   **SKU:** SEEDSKU-0··
 *   **Status:** ACTIVE (low stock …)
 *
 * A SOFT break — a line with no trailing spaces — means "this sentence simply
 * wrapped", and joining it with a space is correct and is what the suite pins.
 * Collapsing BOTH to a space turned the block above into one run-on sentence,
 * while the bubble before AI-4 showed the raw newlines: measured over every
 * stored answer, 16 answers carried 4 hard breaks, both of them this shape from
 * `getProduct` (2026-10-14). So a hard break now survives all the way to a real
 * line break on the screen.
 *
 * The trailing backslash form (`line\`) is deliberately NOT treated as a break:
 * it is not in the measured data, and a genuine trailing backslash is data an
 * answer may legitimately end a line with.
 */
const HARD_BREAK = / {2,}$/;

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*```/;

/**
 * Parse an assistant answer into blocks.
 *
 * Line-oriented and allocation-light on purpose: this runs on the JS thread of a
 * phone every time a bubble renders, so it is memoised per answer by the caller
 * and a large answer (the guard in the suite uses a 40-row table, ~4 KB) stays
 * comfortably inside a single frame.
 */
export function parseAssistantMarkdown(text: string): Block[] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  /**
   * A run of plain lines becomes ONE paragraph, the way Markdown reads it — with
   * its own line-break rule: a HARD break (two or more trailing spaces) ends the
   * current chunk and becomes a real newline, while a soft run of lines stays one
   * chunk joined by spaces, exactly as it always did. Emitting the newline as its
   * own span is what carries the break through the renderer unchanged, since a
   * React Native `<Text>` shows `\n` as a line break.
   */
  const paragraph = (run: string[]): void => {
    const spans: Cell = [];
    let chunk: string[] = [];
    const flush = (): void => {
      if (!chunk.length) return;
      spans.push(...parseInline(chunk.join(' ').trim()));
      chunk = [];
    };

    run.forEach((line, index) => {
      const text = line.trim();
      if (!text) return;
      if (index > 0 && HARD_BREAK.test(run[index - 1])) {
        flush();
        spans.push({ text: '\n' });
      }
      chunk.push(text);
    });
    flush();

    if (spans.length) blocks.push({ kind: 'paragraph', spans });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code: everything up to the closing fence is literal.
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence (or fall off the end of an unclosed one)
      blocks.push({ kind: 'code', text: body.join('\n').trim() });
      continue;
    }

    // Table: a pipe line whose next line is a separator, or another pipe line.
    if (startsTable(lines, i)) {
      const header: Row = splitCells(line).map(parseInline);
      i += 1;
      if (isSeparatorRow(lines[i])) i += 1;
      const rows: Row[] = [];
      // A row may be WRAPPED by the provider across several lines, and a wrapped
      // fragment still contains its pipes — so "has a pipe" continues the table
      // and the first line without one ends it.
      let open: string | null = null;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const fragment = lines[i].trim();
        open = open === null ? fragment : `${open} ${fragment}`;
        // A fragment ending in a pipe closes the row; otherwise the next line may
        // still be part of it.
        if (fragment.endsWith('|') || (i + 1 < lines.length && !lines[i + 1].includes('|'))) {
          rows.push(splitCells(open).map(parseInline));
          open = null;
        }
        i += 1;
      }
      if (open !== null) rows.push(splitCells(open).map(parseInline));
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, spans: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    // Lists: contiguous same-kind items form one list.
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = isOrdered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!m) break;
        items.push({
          marker: isOrdered ? `${(m as RegExpExecArray)[1]}.` : '•',
          spans: parseInline(isOrdered ? (m as RegExpExecArray)[2] : (m as RegExpExecArray)[1]),
        });
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    // Plain text: gather the run, stopping at anything structural.
    const run: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (
        !current.trim() ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current) ||
        startsTable(lines, i)
      ) {
        break;
      }
      run.push(current);
      i += 1;
    }
    paragraph(run);
  }

  return blocks;
}

export const assistantMarkdown = { parseAssistantMarkdown, parseInline, stripMarkdown, stripLatex };

export default assistantMarkdown;
