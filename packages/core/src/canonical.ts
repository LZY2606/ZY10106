const ARRAY_ITEM_REGEXP = /\[[0-9]+?\]$/;
const LAST_INDEXED_ARRAY_REGEXP = /(.*)(\[)([0-9]*)(\])$/;
const ARRAY_OF_ARRAYS_REGEXP = /\[([0-9]+)\]\[([0-9]+)\]/g;

export interface BracketMatch {
  content: string;
  index: number;
  text: string;
}

export interface ArrayIndexGroupState {
  lastIndex: number;
  indexes: Record<string, number>;
  emptyIndexGroup?: {
    index: number;
    seenSuffixes: Set<string>;
  };
}

export type ArrayIndexesMap = Record<string, ArrayIndexGroupState>;

export function findBracketMatches(input: string): BracketMatch[] {
  const matches: BracketMatch[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const startIndex = input.indexOf("[", cursor);
    if (startIndex === -1) {
      break;
    }

    const endIndex = input.indexOf("]", startIndex + 1);
    if (endIndex === -1) {
      break;
    }

    matches.push({
      content: input.slice(startIndex + 1, endIndex),
      index: startIndex,
      text: input.slice(startIndex, endIndex + 1)
    });
    cursor = endIndex + 1;
  }

  return matches;
}

export function createArrayIndexesMap(): ArrayIndexesMap {
  return Object.create(null) as ArrayIndexesMap;
}

export function normalizeName(
  name: string,
  delimiter: string,
  arrayIndexes: ArrayIndexesMap
): string {
  let nameToNormalize = name;
  const rawChunks = name.split(delimiter);
  const normalizedRawChunks: string[] = [];

  for (const rawChunk of rawChunks) {
    const bracketMatches = findBracketMatches(rawChunk);
    if (bracketMatches.length === 0) {
      normalizedRawChunks.push(rawChunk);
      continue;
    }

    let currentChunk = "";
    let cursor = 0;

    for (const match of bracketMatches) {
      const literalText = rawChunk.slice(cursor, match.index ?? cursor);
      if (literalText !== "") {
        currentChunk += literalText;
      }

      const bracketContent = match.content;
      const isArraySegment = bracketContent === "" || /^\d+$/.test(bracketContent);

      if (isArraySegment) {
        if (currentChunk !== "" && currentChunk.endsWith("]")) {
          normalizedRawChunks.push(currentChunk);
          currentChunk = "";
        }

        currentChunk = `${currentChunk}[${bracketContent}]`;
      } else {
        if (currentChunk !== "") {
          normalizedRawChunks.push(currentChunk);
        }

        currentChunk = bracketContent;
      }

      cursor = match.index + match.text.length;
    }

    const trailingText = rawChunk.slice(cursor);
    if (trailingText !== "") {
      currentChunk += trailingText;
    }

    if (currentChunk !== "") {
      normalizedRawChunks.push(currentChunk);
    }
  }

  if (normalizedRawChunks.length > 0) {
    nameToNormalize = normalizedRawChunks.join(delimiter);
  }

  const normalizedNameChunks: string[] = [];
  const chunks = nameToNormalize
    .replace(ARRAY_OF_ARRAYS_REGEXP, "[$1].[$2]")
    .split(delimiter);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const currentChunk = chunks[chunkIndex] ?? "";
    normalizedNameChunks.push(currentChunk);

    const nameMatches = currentChunk.match(LAST_INDEXED_ARRAY_REGEXP);
    if (!nameMatches) {
      continue;
    }

    let currentNormalizedName = normalizedNameChunks.join(delimiter);
    const currentIndex = currentNormalizedName.replace(LAST_INDEXED_ARRAY_REGEXP, "$3");
    currentNormalizedName = currentNormalizedName.replace(LAST_INDEXED_ARRAY_REGEXP, "$1");

    let arrayIndexInfo = arrayIndexInfoAt(arrayIndexes, currentNormalizedName);
    if (!arrayIndexInfo) {
      arrayIndexInfo = {
        lastIndex: -1,
        indexes: Object.create(null) as Record<string, number>
      };
      Object.defineProperty(arrayIndexes, currentNormalizedName, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: arrayIndexInfo
      });
    }

    if (currentIndex === "") {
      const remainingPath = chunks.slice(chunkIndex + 1).join(delimiter);
      const currentGroup = arrayIndexInfo.emptyIndexGroup;

      if (
        !currentGroup ||
        remainingPath === "" ||
        currentGroup.seenSuffixes.has(remainingPath)
      ) {
        arrayIndexInfo.lastIndex += 1;
        arrayIndexInfo.emptyIndexGroup = {
          index: arrayIndexInfo.lastIndex,
          seenSuffixes: new Set(remainingPath === "" ? [] : [remainingPath])
        };
      } else {
        currentGroup.seenSuffixes.add(remainingPath);
      }
    } else if (arrayIndexInfo.indexes[currentIndex] === undefined) {
      arrayIndexInfo.lastIndex += 1;
      arrayIndexInfo.indexes[currentIndex] = arrayIndexInfo.lastIndex;
    }

    const newIndex =
      currentIndex === ""
        ? (arrayIndexInfo.emptyIndexGroup?.index ?? 0)
        : arrayIndexInfo.indexes[currentIndex];
    normalizedNameChunks[normalizedNameChunks.length - 1] = currentChunk.replace(
      LAST_INDEXED_ARRAY_REGEXP,
      `$1$2${newIndex}$4`
    );
  }

  return normalizedNameChunks.join(delimiter).replace("].[", "][");
}

function arrayIndexInfoAt(
  arrayIndexes: ArrayIndexesMap,
  key: string
): ArrayIndexGroupState | undefined {
  return Object.prototype.hasOwnProperty.call(arrayIndexes, key)
    ? arrayIndexes[key]
    : undefined;
}

export interface FieldNameCanonicalizer {
  canonicalize(rawName: string): string;
  canonicalizeArrayName(rawName: string): string;
}

export function createFieldNameCanonicalizer(delimiter = "."): FieldNameCanonicalizer {
  const arrayIndexes = createArrayIndexesMap();

  return {
    canonicalize(rawName: string): string {
      return normalizeName(rawName, delimiter, arrayIndexes);
    },
    canonicalizeArrayName(rawName: string): string {
      return normalizeName(rawName, delimiter, arrayIndexes).replace(ARRAY_ITEM_REGEXP, "[]");
    }
  };
}

export function parseCanonicalPath(path: string, delimiter = "."): PathSegment[] {
  const segments: PathSegment[] = [];

  for (const rawPart of path.split(delimiter)) {
    const bracketMatches = findBracketMatches(rawPart);

    if (bracketMatches.length === 0) {
      if (rawPart !== "") {
        segments.push({ type: "object", key: rawPart });
      }
      continue;
    }

    let cursor = 0;
    let literal = "";

    for (const match of bracketMatches) {
      literal += rawPart.slice(cursor, match.index);

      if (literal !== "") {
        segments.push({ type: "object", key: literal });
        literal = "";
      }

      if (match.content === "") {
        segments.push({ type: "append" });
      } else {
        segments.push({ type: "index", index: Number(match.content) });
      }

      cursor = match.index + match.text.length;
    }

    const trailing = rawPart.slice(cursor);
    if (trailing !== "") {
      segments.push({ type: "object", key: trailing });
    }
  }

  return segments;
}

export type PathSegment =
  | { type: "object"; key: string }
  | { type: "index"; index: number }
  | { type: "append" };

export function formatCanonicalPath(segments: readonly PathSegment[]): string {
  let result = "";

  for (const segment of segments) {
    if (segment.type === "object") {
      if (result !== "" && !result.endsWith("]")) {
        result += ".";
      }

      result += segment.key;
    } else if (segment.type === "index") {
      result += `[${segment.index}]`;
    } else {
      result += "[]";
    }
  }

  return result;
}

export { ARRAY_ITEM_REGEXP };
