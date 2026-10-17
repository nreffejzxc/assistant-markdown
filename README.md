# assistant-markdown

A **dependency-free** Markdown-subset parser for chat interfaces. It turns an assistant's answer into blocks,
inline styling, tables and plain text — and it will not quietly change a number while doing it.

- Zero dependencies. One TypeScript module. Runs directly on Node ≥ 22.18 (native type stripping) or through any
  bundler.
- Blocks: headings, paragraphs, bullet and numbered lists, tables, fenced code, rules.
- Inline: bold, italic, code — as spans a renderer can style, not as punctuation.
- LaTeX decoding for the maths formatting models emit: `\frac`, `\times`, `\mathbf`, `\%` and friends.
- 11 tests, `node --test`, no framework.

## Why it exists

A chat bubble in a native app is usually a `<Text>` node. It is not an HTML or Markdown renderer, so a model that
formats the way models do shows the member its own markup:

```
**no products that need restocking**
```

Stripping the markers is the easy half. The half that matters is **not stripping the ones that are data**:

```ts
stripMarkdown('SKU_123_AB and MIN_STOCK_LEVEL');  // unchanged — underscores here are identifiers
stripMarkdown('12 * 3 = 36');                     // unchanged — arithmetic, not emphasis
stripMarkdown('4*5*6');                           // unchanged — NOT '456'
```

That last line is the reason for the parser's central rule. Without a word boundary, a naive emphasis rule rewrites
`4*5*6` as `456`: a quantity silently changed, in an assistant whose job is to report quantities. **A marker only
counts as markup when it stands apart from a word.** Ambiguous markup is treated as data — visible markers are ugly;
a wrong number is wrong.

## The other rule worth knowing

A fraction side that carries an operator keeps its brackets:

```ts
stripMarkdown('\\frac{17 + 5}{113}');   // '(17 + 5)/113'   — 19.5%
stripMarkdown('\\frac{1}{2 \\times 3}');// '1/(2 × 3)'      — one sixth
stripMarkdown('\\frac{620}{10,000}');   // '620/10,000'     — a single term is untouched
```

Dropping the brackets is not cosmetic. `\frac{17 + 5}{113}` decoded to `17 + 5/113` reads as **17.04**, and
`\frac{1}{2 \times 3}` decoded to `1/2 × 3` reads as **one and a half** — both plausible-looking answers that are
wrong. The rule covers `+ - − × · ÷ /` (and `\times`, `\cdot`, `\div`, `\pm`, `\mp`) because the fraction bar binds
tighter than all of them.

## Use

```ts
import { parseAssistantMarkdown, stripMarkdown } from 'assistant-markdown';

const blocks = parseAssistantMarkdown(answer);
// [{ kind: 'heading', level: 3, spans: [...] },
//  { kind: 'table', header: [...], rows: [[...], [...]] },
//  { kind: 'list', ordered: false, items: [{ marker: '•', spans: [...] }] },
//  { kind: 'paragraph', spans: [...] }]
```

Each block carries `spans: { text, bold?, italic?, code? }[]`, so a renderer styles runs instead of printing
asterisks. Plain text only? `stripMarkdown(answer)` returns one string with the structure flattened away.

Types are exported: `Block`, `InlineSpan`, `List`, `Table`, `Cell`, `Row`.

## Install

```bash
npm install github:nreffejzxc/assistant-markdown
```

Not published to npm; it is consumed from the repository.

## Scope and honesty

This is a **subset**, deliberately. It parses what a model actually emits in prose answers — headings, lists,
tables, fenced code, bold/italic/code spans, and the LaTeX commands listed in `src/assistantMarkdown.ts`. It does not
aim to be CommonMark: there are no nested block constructs, no reference links, no HTML passthrough, no images.

It is **pure**: no I/O, no dependencies, no rendering, no React. That is what makes it testable and what makes it safe
to run on any string a model returns.

## Development

```bash
npm ci
npm run typecheck     # tsc --noEmit, strict
npm test              # 11 cases — the tests run on Node's own type stripping, no build step
```

## License

MIT © the author. Extracted from a production React Native inventory app, where it renders the assistant's answers.
