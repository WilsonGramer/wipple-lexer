import escape from "escape-string-regexp";

type Pattern = string | RegExp;

type Rule<T> = Pattern | [Pattern, Transform<T>];

type Transform<T> = (input: string) => Output<T>;

// Used with `words()` to explicitly mark the input strings as outputs.
declare const outputTag: unique symbol;
type HasOutput<T> = { [outputTag]: T };

// Get the output of a `Rule`.
type Output<T> =
    // If the output is explicitly marked (via `words()`, etc.), use that.
    T extends HasOutput<infer O>
        ? O
        : // Simple rules produce their match.
        T extends Pattern
        ? string
        : // Rules with custom transforms produce the output of the transform.
        T extends [Pattern, (input: string) => infer R]
        ? R
        : T;

/** `[start, end)` */
export type Range = [number, number];

export interface AnyToken {
    range: Range;
}

/**
 * Union of all the tokens that can be produced by the provided rules.
 *
 * Instead of `<R extends ...>`, use a conditional type to force TypeScript to
 * elaborate the rules. This causes the IDE to show the actual token types
 * instead of revealing the rules provided to `compile()`.
 */
export type Token<R> = R extends Record<string, Rule<unknown>>
    ? {
          // Skip null/undefined outputs, and completely omit rules whose
          // outputs are always skipped.
          [K in keyof R]: NonNullable<Output<R[K]>> extends never
              ? never
              : AnyToken & { type: K; value: NonNullable<Output<R[K]>> };
      }[keyof R]
    : never;

/**
 * Object returned by `compile()`.
 */
export interface Tokenizer<R extends Record<string, unknown>> {
    /**
     * Tokenize an input string.
     */
    (input: string): IteratorObject<Token<R>>;

    /**
     * The regex used to tokenize the input.
     */
    regex: RegExp;

    /**
     * The regexes for each individual token, to be used for syntax
     * highlighting, etc.
     */
    tokens: Record<keyof R, RegExp>;
}

// Regex utilities

export const any = (...choices: RegExp[]) =>
    new RegExp(`(?:${choices.map((r) => r.source).join("|")})`);

export const skip = () => undefined;

export const concat = (first: RegExp, ...rest: (RegExp | undefined)[]) =>
    new RegExp([first, ...rest.filter((r) => r != null)].map((r) => r.source).join(""));

export const notFollowing = (regex: RegExp) => new RegExp(`(?<!${regex.source})`);

export const notFollowedBy = (regex: RegExp) => new RegExp(`(?!${regex.source})`);

export const repeat = (regex: RegExp, suffix: "*" | "+" | "?") =>
    new RegExp(`(?:${regex.source})${suffix}`);

/**
 * Utility to match multiple options for a single token, followed by a boundary.
 */
export const words = <C extends string[]>(choices: C, ...rest: RegExp[]) =>
    concat(
        any(...choices.toSorted((a, b) => b.length - a.length).map((s) => new RegExp(escape(s)))),
        ...rest
    ) as RegExp & HasOutput<C[number]>;

/**
 * Create a tokenizer from a set of rules. All the rules are compiled into a
 * single regex.
 */
export const compile = <R extends Record<string, Rule<unknown>>>(rules: R): Tokenizer<R> => {
    const { regex, tokens, transforms } = buildRegex(rules);

    // Create a function that tokenizes an input string.
    const tokenize = (str: string) =>
        matchRegex(str, regex).flatMap(({ range, type, match }) => {
            // Transform the match and produce a token, skipping null/undefined
            // outputs.
            const value = transforms[type](match);
            if (value == null) return [];

            // We need to cast here because TypeScript cannot prove that
            // `type` and `value` are related through the regex.
            const token = { range, type, value } as Token<R>;

            return [token];
        });

    // Give the caller access to the compiled rules.
    tokenize.regex = regex;
    tokenize.tokens = tokens;

    return tokenize;
};

const buildRegex = <R extends Record<string, Rule<unknown>>>(rules: R) => {
    // Get each rule's regex and transform.
    const tokens = {} as Record<keyof R, RegExp>;
    const transforms = {} as Record<keyof R, Transform<unknown>>;
    for (const key in rules) {
        const rule = rules[key];

        // Default to the identity transform.
        const identity: Transform<unknown> = (s) => s;
        const [pattern, transform] = Array.isArray(rule) ? rule : [rule, identity];

        const regex = typeof pattern === "string" ? new RegExp(escape(pattern)) : pattern;

        tokens[key] = regex;
        transforms[key] = transform;
    }

    // Build a single regex from all the rules. Each rule is in a named capturing
    // group so we can check which one matched.

    const groups = Object.entries(tokens).map(
        ([key, pattern]) => new RegExp(`(?<${key}>${pattern.source})`)
    );

    const regex = new RegExp(any(...groups), "g");

    return { regex, tokens, transforms };
};

const matchRegex = (str: string, regex: RegExp) =>
    str.matchAll(regex).map((result) => {
        // Get the (first) capture group that matched at this position.
        const capture = Object.entries(result.groups!).find(([_, match]) => match != null);
        if (!capture) {
            throw new Error(`input not matched by any rule at index ${result.index}`);
        }

        const [type, match] = capture;
        const { length } = match;

        const range: Range = [result.index, result.index + length];

        return { range, type, match };
    });

export interface TextmateGrammar<Name extends string> {
    $schema: string;
    name: Name;
    scopeName: `source.${Name}`;
    patterns: TextmatePattern[];
    repository: Record<string, TextmatePattern>;
}

export interface TextmatePattern {
    name: string;
    match: string;
}

/** Export a tokenizer to TextMate format. */
export const toTextmate = <T extends Record<string, RegExp>, Name extends string>(
    tokens: T,
    options: {
        name: Name;
        textmateNames: Partial<Record<keyof T, string>>;
    }
): TextmateGrammar<Name> => ({
    $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    name: options.name,
    scopeName: `source.${options.name}`,
    patterns: Object.entries(tokens)
        .filter(([token]) => token in options.textmateNames)
        .map(([token, pattern]) => ({
            name: options.textmateNames[token]!,
            match: pattern.source,
        })),
    repository: {},
});
