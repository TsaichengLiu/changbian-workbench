import * as OpenCC from "opencc-js";

let twToCnConverter: ((text: string) => string) | null = null;
let cnToTwConverter: ((text: string) => string) | null = null;

try {
  twToCnConverter = OpenCC.Converter({ from: "tw", to: "cn" });
  cnToTwConverter = OpenCC.Converter({ from: "cn", to: "tw" });
} catch {
  twToCnConverter = null;
  cnToTwConverter = null;
}

function clean(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function buildVariants(text: string): string[] {
  const base = clean(text);
  if (!base) {
    return [];
  }

  const set = new Set<string>([base]);

  if (twToCnConverter) {
    set.add(clean(twToCnConverter(text)));
  }

  if (cnToTwConverter) {
    set.add(clean(cnToTwConverter(text)));
  }

  return [...set].filter(Boolean);
}

export function matchesTraditionalSimplified(haystack: string, query: string): boolean {
  const queryVariants = buildVariants(query);
  if (queryVariants.length === 0) {
    return true;
  }

  const haystackVariants = buildVariants(haystack);
  return queryVariants.some((queryVariant) =>
    haystackVariants.some((haystackVariant) => haystackVariant.includes(queryVariant)),
  );
}
