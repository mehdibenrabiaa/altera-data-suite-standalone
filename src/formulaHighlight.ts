// Client-side tokenizer for Add Column's formula language -- purely for
// syntax-highlighting the Configure window's formula box (see
// AddColumnWindow.tsx's overlay technique) and for driving its
// autocomplete's context detection below. The formula never actually
// RUNS here (no JS evaluator to keep in sync with backend/app/nodes.py's
// safe AST-walking one) -- this only needs to recognize the same handful
// of syntactic shapes ([Column], "string", 123, UPPER(...), operators)
// well enough to color and complete them, not to reject anything actually
// invalid; the real formula is only ever validated by the backend, on
// Apply/Run.
export type FormulaTokenType = "bracket" | "string" | "number" | "function" | "operator" | "paren" | "text";
export interface FormulaToken {
  type: FormulaTokenType;
  text: string;
}

// Kept in sync by hand with backend/app/nodes.py's _FORMULA_FUNCTIONS keys
// -- purely for highlighting/autocomplete here, so a mismatch is cosmetic
// (a function the backend supports just wouldn't get colored/suggested),
// never a correctness issue for what the formula actually does.
export const FORMULA_FUNCTIONS = ["UPPER", "LOWER", "TRIM", "LEN", "CONCAT", "ROUND", "LEFT", "RIGHT", "ABS"];

const IDENTIFIER_CHAR = /[A-Za-z_0-9]/;
const OPERATOR_CHAR = /[+\-*/%^]/;

// Every token's `.text` concatenated back together must reconstruct the
// input EXACTLY (including whitespace and any malformed/partial syntax
// mid-edit) -- the highlight overlay renders these tokens in place of the
// real text, so any drift here would make it visibly disagree with what's
// actually in the textarea underneath it.
export function tokenizeFormula(src: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "[") {
      const end = src.indexOf("]", i);
      const stop = end === -1 ? src.length : end + 1;
      tokens.push({ type: "bracket", text: src.slice(i, stop) });
      i = stop;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j++;
      const stop = Math.min(j + 1, src.length);
      tokens.push({ type: "string", text: src.slice(i, stop) });
      i = stop;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: "number", text: src.slice(i, j) });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && IDENTIFIER_CHAR.test(src[j])) j++;
      const word = src.slice(i, j);
      tokens.push({ type: FORMULA_FUNCTIONS.includes(word.toUpperCase()) ? "function" : "text", text: word });
      i = j;
      continue;
    }

    if (OPERATOR_CHAR.test(ch)) {
      tokens.push({ type: "operator", text: ch });
      i++;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ type: "paren", text: ch });
      i++;
      continue;
    }

    // Whitespace or anything else not handled above -- run together as
    // plain, unstyled text rather than one token per character.
    let j = i;
    while (
      j < src.length &&
      src[j] !== "[" &&
      src[j] !== '"' &&
      !/[0-9A-Za-z_]/.test(src[j]) &&
      !OPERATOR_CHAR.test(src[j]) &&
      src[j] !== "(" &&
      src[j] !== ")" &&
      src[j] !== ","
    ) {
      j++;
    }
    if (j === i) j++; // safety net, should be unreachable
    tokens.push({ type: "text", text: src.slice(i, j) });
    i = j;
  }
  return tokens;
}

// Autocomplete's context detection: what's being typed right at `cursor`
// -- a [Column reference (still-open bracket, no matching "]" yet before
// the cursor) or a bare function-name-shaped word. Scans backward only
// through the CURRENT line (a real formula is always one line here, but a
// stray newline shouldn't make this walk arbitrarily far back) and stops
// at the nearest unescaped syntax boundary.
export type FormulaCompletionContext =
  | { kind: "column"; query: string; from: number }
  | { kind: "function"; query: string; from: number }
  | null;

export function getFormulaCompletionContext(text: string, cursor: number): FormulaCompletionContext {
  let i = cursor - 1;
  while (i >= 0 && text[i] !== "[" && text[i] !== "]" && text[i] !== "\n") i--;
  if (i >= 0 && text[i] === "[") {
    return { kind: "column", query: text.slice(i + 1, cursor), from: i };
  }
  let j = cursor;
  while (j > 0 && /[A-Za-z_]/.test(text[j - 1])) j--;
  if (j < cursor) {
    return { kind: "function", query: text.slice(j, cursor), from: j };
  }
  return null;
}

// A render-ready piece: either a real token slice (possibly a token split
// in two at the cursor) or the zero-width "caret" marker itself. Used by
// AddColumnWindow.tsx to render the highlight overlay with an actual DOM
// node sitting exactly at the cursor position, whose getBoundingClientRect()
// is how the floating autocomplete popup knows where to appear -- there's
// no other reliable way to find a textarea's on-screen caret position
// short of measuring a same-styled mirror like this one already is.
export type FormulaRenderPart =
  | { kind: "token"; key: string; type: FormulaTokenType; text: string }
  | { kind: "caret"; key: "caret" };

export function splitTokensAtCursor(tokens: FormulaToken[], cursor: number): FormulaRenderPart[] {
  const parts: FormulaRenderPart[] = [];
  let pos = 0;
  let placed = false;
  tokens.forEach((t, i) => {
    const start = pos;
    const end = pos + t.text.length;
    if (!placed && cursor >= start && cursor <= end) {
      const before = t.text.slice(0, cursor - start);
      const after = t.text.slice(cursor - start);
      if (before) parts.push({ kind: "token", key: `${i}-a`, type: t.type, text: before });
      parts.push({ kind: "caret", key: "caret" });
      if (after) parts.push({ kind: "token", key: `${i}-b`, type: t.type, text: after });
      placed = true;
    } else {
      parts.push({ kind: "token", key: `${i}`, type: t.type, text: t.text });
    }
    pos = end;
  });
  if (!placed) parts.push({ kind: "caret", key: "caret" });
  return parts;
}

// Every function's real parameter list + a one-line description -- shown
// as an Excel-style argument tooltip while the cursor sits inside that
// function's parens (see getFunctionCallContext below), and kept in sync
// by hand with FORMULA_FUNCTIONS/backend/app/nodes.py's _FORMULA_FUNCTIONS
// (same reasoning as that list's own comment: a mismatch here is cosmetic,
// never a correctness issue for what the formula actually does).
export const FUNCTION_SIGNATURES: Record<string, { params: string[]; description: string }> = {
  UPPER: { params: ["text"], description: "Converts text to uppercase." },
  LOWER: { params: ["text"], description: "Converts text to lowercase." },
  TRIM: { params: ["text"], description: "Removes leading and trailing spaces." },
  LEN: { params: ["text"], description: "Returns the number of characters in text." },
  CONCAT: { params: ["value1", "value2", "…"], description: "Joins values together as text." },
  ROUND: { params: ["number", "decimals"], description: "Rounds number to the given number of decimal places." },
  LEFT: { params: ["text", "count"], description: "Returns the first count characters of text." },
  RIGHT: { params: ["text", "count"], description: "Returns the last count characters of text." },
  ABS: { params: ["number"], description: "Returns the absolute value of number." },
};

// What function call (if any) the cursor is currently INSIDE the parens
// of, and which argument position it's on -- an Excel formula bar shows
// exactly this (the function's full signature, with the argument you're
// currently typing bolded) the moment you're between a function's ( and
// ). Scans backward tracking paren depth so a nested call (e.g. the
// cursor inside ROUND's args while ROUND itself sits inside CONCAT(...))
// correctly resolves to the INNERMOST enclosing call, not the outer one.
export interface FormulaCallContext {
  name: string;
  argIndex: number;
}

export function getFunctionCallContext(text: string, cursor: number): FormulaCallContext | null {
  let depth = 0;
  let argIndex = 0;
  let i = cursor - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '"') {
      let j = i - 1;
      while (j >= 0 && text[j] !== '"') j--;
      i = j - 1;
      continue;
    }
    if (ch === ")") {
      depth++;
    } else if (ch === "(") {
      if (depth === 0) {
        let j = i - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        const end = j + 1;
        while (j >= 0 && /[A-Za-z_]/.test(text[j])) j--;
        const name = text.slice(j + 1, end).toUpperCase();
        return FORMULA_FUNCTIONS.includes(name) ? { name, argIndex } : null;
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      argIndex++;
    }
    i--;
  }
  return null;
}

// A best-effort recursive-descent check of the SAME grammar backend/app/
// nodes.py's export_data safe evaluator actually walks (expr := term (+
// or - term)*, term := factor (* / % or ^ factor)*, factor := unary +/-
// or an atom, atom := number/string/[Column]/FUNC(args)/(expr)) -- catches
// the same shapes of mistake a user typing a real formula actually makes
// (an unclosed bracket/paren/string, an unknown column or function name,
// a dangling operator) WITHOUT needing a full re-implementation of the
// backend's evaluator; this only ever validates SHAPE, never computes a
// value, so there's no real logic to keep in sync beyond the grammar
// itself and the two name lists above. The backend's own parser is still
// what actually runs the formula on Apply/Run -- this exists purely to
// give feedback faster than that round trip, and a formula this accepts
// as "valid shape" can still fail there for a reason this never checks
// (e.g. ROUND()'s second argument not being a real number at runtime).
export function validateFormula(text: string, columns: string[]): string | null {
  const tokens = tokenizeFormula(text).filter((t) => !(t.type === "text" && t.text.trim() === ""));
  if (tokens.length === 0) return null;

  let pos = 0;
  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];

  function parseExpr(): string | null {
    const first = parseTerm();
    if (first) return first;
    while (peek() && peek().type === "operator" && (peek().text === "+" || peek().text === "-")) {
      advance();
      const err = parseTerm();
      if (err) return err;
    }
    return null;
  }
  function parseTerm(): string | null {
    const first = parseFactor();
    if (first) return first;
    while (peek() && peek().type === "operator" && "*/%^".includes(peek().text)) {
      advance();
      const err = parseFactor();
      if (err) return err;
    }
    return null;
  }
  function parseFactor(): string | null {
    if (peek() && peek().type === "operator" && (peek().text === "+" || peek().text === "-")) {
      advance();
      return parseFactor();
    }
    return parseAtom();
  }
  function parseAtom(): string | null {
    const t = peek();
    if (!t) return "Formula ends unexpectedly -- expected a value.";
    if (t.type === "number" || t.type === "string") {
      if (t.type === "string" && !t.text.endsWith('"')) return `Missing closing " for ${t.text}`;
      advance();
      return null;
    }
    if (t.type === "bracket") {
      if (!t.text.endsWith("]")) return `Missing closing ] for ${t.text}`;
      const colName = t.text.slice(1, -1);
      if (!columns.includes(colName)) return `Column "${colName}" not found.`;
      advance();
      return null;
    }
    if (t.type === "function" || t.type === "text") {
      if (t.type === "text") return `Unknown reference "${t.text}" -- use [${t.text}] for a column, or one of the supported functions.`;
      const name = t.text.toUpperCase();
      advance();
      const open = peek();
      if (!open || !(open.type === "paren" && open.text === "(")) return `Expected ( after ${name}`;
      advance();
      if (!(peek() && peek().type === "paren" && peek().text === ")")) {
        let err = parseExpr();
        if (err) return err;
        while (peek() && peek().type === "paren" && peek().text === ",") {
          advance();
          err = parseExpr();
          if (err) return err;
        }
      }
      const close = peek();
      if (!close || !(close.type === "paren" && close.text === ")")) return `Missing closing ) for ${name}(`;
      advance();
      return null;
    }
    if (t.type === "paren" && t.text === "(") {
      advance();
      const err = parseExpr();
      if (err) return err;
      const close = peek();
      if (!close || !(close.type === "paren" && close.text === ")")) return "Missing closing )";
      advance();
      return null;
    }
    return `Unexpected "${t.text}"`;
  }

  const err = parseExpr();
  if (err) return err;
  if (pos < tokens.length) return `Unexpected "${tokens[pos].text}" -- formula should have ended before this.`;
  return null;
}

// Auto-reformat (AddColumnWindow.tsx debounces this to ~3s after the user
// stops typing, and only ever calls it once validateFormula above has
// already confirmed the formula parses -- reformatting something broken
// has no sensible "correct" spacing to apply, and callers should not spend
// caution here re-checking that themselves). ONLY ever touches WHITESPACE
// between tokens -- token content itself (a string's own text, a bracket's
// own column name, a number's own digits) always passes through byte-for-
// byte -- which is what lets mapCursorAfterFormat below reposition the
// caret exactly by counting non-whitespace characters rather than needing
// any real diff/mapping between the two strings.
export function formatFormula(text: string): string {
  const tokens = tokenizeFormula(text).filter((t) => !(t.type === "text" && t.text.trim() === ""));
  let out = "";
  let prevIsValue = false;
  for (const t of tokens) {
    if (t.type === "paren" && t.text === ")") {
      out += ")";
      prevIsValue = true;
    } else if (t.type === "paren" && t.text === "(") {
      out += "(";
      prevIsValue = false;
    } else if (t.type === "paren" && t.text === ",") {
      out += ", ";
      prevIsValue = false;
    } else if (t.type === "operator") {
      // A leading (or just-after-(/,/another-operator) +/- is unary --
      // stays tight against its operand ("-5"), same as how anyone would
      // actually write it by hand; every other operator (and a binary
      // +/-, i.e. one with a real left-hand value before it) always gets
      // a single space on both sides ("[A] - 5"), matching Excel/most
      // formula formatting conventions.
      const isUnary = (t.text === "+" || t.text === "-") && !prevIsValue;
      out += isUnary ? t.text : ` ${t.text} `;
      prevIsValue = false;
    } else {
      out += t.text;
      prevIsValue = true;
    }
  }
  return out.replace(/ {2,}/g, " ").trim();
}

// Where the caret should land in `newText` (formatFormula's output) to
// stay "in the same place" relative to `oldText` -- counts how many non-
// whitespace characters preceded the caret before formatting, then walks
// `newText` to the position with that same count before it. Works exactly
// (not just approximately) because formatFormula only ever changes
// whitespace, never any token's own content.
export function mapCursorAfterFormat(oldText: string, oldCursor: number, newText: string): number {
  const targetNonSpace = oldText.slice(0, oldCursor).replace(/\s/g, "").length;
  let count = 0;
  for (let i = 0; i < newText.length; i++) {
    if (count === targetNonSpace) return i;
    if (!/\s/.test(newText[i])) count++;
  }
  return newText.length;
}
