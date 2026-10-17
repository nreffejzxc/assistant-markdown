/**
 * The parser's own guarantees, ported from the production app it was extracted from and run with `node --test` —
 * no framework, no dependencies, because the module has none.
 *
 * Three properties are load-bearing, and every case below exists because breaking one of them produced a wrong
 * answer on a real screen:
 *
 *  1. **A marker must stand apart from a word.** Without this rule `4*5*6` becomes `456` — a quantity silently
 *     changed — which is the worst class of bug in an assistant that reports numbers.
 *  2. **A single underscore is never emphasis.** `SKU_123_AB` and `MIN_STOCK_LEVEL` are data.
 *  3. **A fraction side carrying an operator keeps its brackets.** `\frac{17 + 5}{113}` is `(17+5)/113`; dropping
 *     them reads as 17.04 instead of 19.5%.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAssistantMarkdown, parseInline, stripLatex, stripMarkdown } from '../src/assistantMarkdown.ts';

test('stripMarkdown removes the markers a model writes and keeps the words', () => {
  assert.equal(stripMarkdown('**no products that need restocking**'), 'no products that need restocking');
  assert.equal(stripMarkdown('There are **3** products low on stock.'), 'There are 3 products low on stock.');
  assert.equal(stripMarkdown('__Widget A__ is out of stock.'), 'Widget A is out of stock.');
  assert.equal(stripMarkdown('That item is *critical* now.'), 'That item is critical now.');
  assert.equal(stripMarkdown('The SKU `WID-001` has 4 left.'), 'The SKU WID-001 has 4 left.');
  assert.equal(stripMarkdown('### Low stock\n3 products'), 'Low stock\n3 products');
});

test('stripMarkdown leaves prose and identifiers untouched', () => {
  const prose = 'You have 12 units of Widget A at Main Warehouse, 3 of them reserved.';
  assert.equal(stripMarkdown(prose), prose);

  // These are data, not emphasis.
  const codes = 'SKU_123_AB, product_code, snake_case and MIN_STOCK_LEVEL';
  assert.equal(stripMarkdown(codes), codes);

  // A lone asterisk is not always emphasis: this is arithmetic.
  assert.equal(stripMarkdown('12 * 3 = 36 units in total'), '12 * 3 = 36 units in total');
  assert.equal(stripMarkdown('- Widget A: 3\n- Widget B: 0'), '- Widget A: 3\n- Widget B: 0');
  assert.equal(stripMarkdown('#1 selling product'), '#1 selling product');
  assert.equal(stripMarkdown('Total value: $1,200.50'), 'Total value: $1,200.50');
});

test('★ a marker inside a word is data, not markup', () => {
  // The defect this rule exists for: `4*5*6` was rendered as `456`.
  assert.equal(stripMarkdown('4*5*6'), '4*5*6');
  assert.equal(stripMarkdown('A*B*C'), 'A*B*C');

  const spans = parseInline('4*5*6');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, '4*5*6');
});

test('LaTeX decodes into text a person can read', () => {
  assert.equal(stripMarkdown('\\( \\frac{620}{10,000} \\times 100 = \\mathbf{6.2\\%} \\)'), '620/10,000 × 100 = 6.2%');
  assert.equal(stripMarkdown('\\frac{1}{2}'), '1/2');
  assert.equal(stripMarkdown('3 \\times 4'), '3 × 4');
  assert.equal(stripMarkdown('\\mathbf{Bold}'), 'Bold');
  assert.equal(stripMarkdown('\\text{plain}'), 'plain');
  assert.equal(stripMarkdown('a \\leq b \\geq c \\neq d'), 'a ≤ b ≥ c ≠ d');
  assert.equal(stripMarkdown('100\\%'), '100%');
});

test('★ a fraction side carrying an operator keeps its brackets', () => {
  // The spacing inside a side is the model's, and is preserved — only the brackets are added.
  assert.equal(stripMarkdown('\\frac{17 + 5}{113}'), '(17 + 5)/113');
  assert.equal(stripMarkdown('\\frac{17+5}{113}'), '(17+5)/113');
  assert.equal(stripMarkdown('\\frac{n - 1}{2 + k}'), '(n - 1)/(2 + k)');
  assert.equal(stripMarkdown('\\frac{1}{2 \\times 3}'), '1/(2 × 3)');
  assert.equal(stripMarkdown('\\frac{a \\times b}{c}'), '(a × b)/c');
  assert.equal(stripMarkdown('\\frac{6}{2 \\div 3}'), '6/(2 ÷ 3)');
  assert.equal(stripMarkdown('\\frac{x \\cdot y}{z}'), '(x · y)/z');
  assert.equal(stripMarkdown('\\frac{a}{b/c}'), 'a/(b/c)');
});

test('an unrecognised backslash sequence is left alone', () => {
  const path = 'saved in C:\\Users\\dev\\reports';
  assert.equal(stripMarkdown(path), path);
});

test('parseAssistantMarkdown reads the block structures a model writes', () => {
  const blocks = parseAssistantMarkdown('### Low stock\n- Widget A: 3\n- Widget B: 0');
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'list'],
  );

  const heading = blocks[0];
  assert.equal(heading.kind, 'heading');
  assert.equal(heading.level, 3);

  const list = blocks[1];
  assert.equal(list.kind, 'list');
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 2);
});

test('★ an escaped pipe stays inside its cell, and the columns after it stay aligned', () => {
  // `\|` is Markdown's own way to put a pipe inside a cell. Splitting on every `|` produced three cells — `A`,
  // `B`, `3` — which put every later value in the row one column left of the header it belongs to.
  const table = parseAssistantMarkdown('| Product | Qty |\n| --- | --- |\n| A \\| B | 3 |\n| C | 4 |').find(
    (b) => b.kind === 'table',
  );
  assert.ok(table, 'a table is recognised');
  assert.equal(table.header.length, 2);
  assert.deepEqual(
    table.rows.map((row) => row.map((cell) => cell.map((span) => span.text).join(''))),
    [
      ['A | B', '3'],
      ['C', '4'],
    ],
  );
});

test('★ strikethrough is removed, not shown', () => {
  assert.equal(stripMarkdown('~~old~~ new'), 'old new');
  // …under the same word boundary as every other marker: inside a word, tildes are data.
  assert.equal(stripMarkdown('a~~b~~c'), 'a~~b~~c');
  assert.equal(stripMarkdown('~5 minutes'), '~5 minutes');
});

test('parseAssistantMarkdown reads a table as a header plus rows of styled cells', () => {
  const blocks = parseAssistantMarkdown('| Product | Qty |\n| --- | --- |\n| Widget A | 3 |\n| Widget B | 0 |');
  const table = blocks.find((b) => b.kind === 'table');
  assert.ok(table, 'a table is recognised');
  assert.equal(table.header.length, 2, 'the header row is the header');
  assert.equal(table.rows.length, 2, 'the separator row is not a row');
  assert.equal(table.rows[1][1][0].text, '0');
});

test('bold survives parsing as styling, not as asterisks', () => {
  const spans = parseInline('**3** products are low');
  assert.equal(spans[0].text, '3');
  assert.equal(spans[0].bold, true);
  assert.equal(spans[1].text, ' products are low');
});

test('stripLatex is exposed on its own for callers that only decode maths', () => {
  assert.equal(stripLatex('\\frac{1}{2}'), '1/2');
});

test('an empty answer parses to nothing rather than to a stray empty block', () => {
  assert.deepEqual(parseAssistantMarkdown(''), []);
  assert.deepEqual(parseAssistantMarkdown('   \n\n  '), []);
});
