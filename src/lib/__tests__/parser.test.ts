import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { extractFunctions } from "../parser.js";

const TEST_DIR = path.join(process.cwd(), "test-fixtures", "parser");

beforeEach(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

async function createTestFile(
  filename: string,
  content: string,
): Promise<string> {
  const filePath = path.join(TEST_DIR, filename);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

describe("extractFunctions", () => {
  describe("valid inputs", () => {
    it("extracts single named function declaration", async () => {
      const filePath = await createTestFile(
        "single.js",
        `function hello() {
  return "world";
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("hello");
      expect(result[0].code).toContain("function hello()");
      expect(result[0].code).toContain('return "world"');
      expect(result[0].filePath).toBe(path.resolve(filePath));
    });

    it("extracts multiple function declarations", async () => {
      const filePath = await createTestFile(
        "multiple.js",
        `function first() {
  return 1;
}

function second() {
  return 2;
}

function third() {
  return 3;
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe("first");
      expect(result[1].name).toBe("second");
      expect(result[2].name).toBe("third");
    });

    it("extracts function with parameters", async () => {
      const filePath = await createTestFile(
        "params.js",
        `function greet(name, greeting = "Hello") {
  return \`\${greeting}, \${name}!\`;
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("greet");
      expect(result[0].code).toContain("name, greeting");
    });

    it("extracts async function", async () => {
      const filePath = await createTestFile(
        "async.js",
        `async function fetchData() {
  const response = await fetch("/api");
  return response.json();
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("fetchData");
      expect(result[0].code).toContain("async function fetchData()");
    });

    it("extracts function with complex body", async () => {
      const filePath = await createTestFile(
        "complex.js",
        `function calculate(x, y) {
  if (x > y) {
    for (let i = 0; i < x; i++) {
      console.log(i);
    }
  }
  return x + y;
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("calculate");
      expect(result[0].code).toContain("if (x > y)");
      expect(result[0].code).toContain("for (let i = 0");
    });

    it("extracts generator function", async () => {
      const filePath = await createTestFile(
        "generator.js",
        `function* numbers() {
  yield 1;
  yield 2;
  yield 3;
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("numbers");
      expect(result[0].code).toContain("function* numbers()");
    });

    it("returns empty array for file without functions", async () => {
      const filePath = await createTestFile(
        "no-functions.js",
        `const x = 1;
const y = 2;
console.log(x + y);`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(0);
    });

    it("ignores arrow functions", async () => {
      const filePath = await createTestFile(
        "arrow.js",
        `const arrow = () => {
  return "arrow";
};

function regular() {
  return "regular";
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("regular");
    });

    it("ignores function expressions", async () => {
      const filePath = await createTestFile(
        "expression.js",
        `const fn = function() {
  return "expression";
};

function declaration() {
  return "declaration";
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("declaration");
    });

    it("ignores method definitions in classes", async () => {
      const filePath = await createTestFile(
        "class.js",
        `class MyClass {
  method() {
    return "method";
  }
}

function standalone() {
  return "standalone";
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("standalone");
    });

    it("handles empty file", async () => {
      const filePath = await createTestFile("empty.js", "");

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(0);
    });

    it("handles file with only whitespace", async () => {
      const filePath = await createTestFile("whitespace.js", "   \n\n\t  ");

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(0);
    });

    it("handles file with comments only", async () => {
      const filePath = await createTestFile(
        "comments.js",
        `// This is a comment
/* This is a block comment */`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(0);
    });

    it("extracts functions with unicode names", async () => {
      const filePath = await createTestFile(
        "unicode.js",
        `function привет() {
  return "hello";
}

function 你好() {
  return "hello";
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("привет");
      expect(result[1].name).toBe("你好");
    });

    it("resolves relative paths", async () => {
      const filename = "relative.js";
      const absolutePath = await createTestFile(
        filename,
        `function test() {
  return true;
}`,
      );
      const relativePath = path.relative(process.cwd(), absolutePath);

      const result = await extractFunctions(relativePath);

      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe(absolutePath);
    });
  });

  describe("error handling", () => {
    it("throws error for non-existent file", async () => {
      const nonExistentPath = path.join(TEST_DIR, "does-not-exist.js");

      await expect(extractFunctions(nonExistentPath)).rejects.toThrow(
        /Failed to read file/,
      );
    });

    it("throws error for empty file path", async () => {
      await expect(extractFunctions("")).rejects.toThrow(/Invalid file path/);
    });

    it("throws error for null file path", async () => {
      await expect(extractFunctions(null as any)).rejects.toThrow(
        /Invalid file path/,
      );
    });

    it("throws error for undefined file path", async () => {
      await expect(extractFunctions(undefined as any)).rejects.toThrow(
        /Invalid file path/,
      );
    });

    it("throws error for non-string file path", async () => {
      await expect(extractFunctions(123 as any)).rejects.toThrow(
        /Invalid file path/,
      );
      await expect(extractFunctions({} as any)).rejects.toThrow(
        /Invalid file path/,
      );
      await expect(extractFunctions([] as any)).rejects.toThrow(
        /Invalid file path/,
      );
    });

    it("throws error for directory instead of file", async () => {
      await expect(extractFunctions(TEST_DIR)).rejects.toThrow(
        /Failed to read file/,
      );
    });

    it("handles file with invalid UTF-8", async () => {
      const filePath = path.join(TEST_DIR, "invalid-utf8.js");
      const buffer = Buffer.from([0xff, 0xfe, 0xfd]);
      await fs.writeFile(filePath, buffer);

      const result = await extractFunctions(filePath);

      expect(Array.isArray(result)).toBe(true);
    });

    it("throws when JavaScript is malformed", async () => {
      const filePath = await createTestFile(
        "malformed.js",
        'function broken( {\n  return "incomplete',
      );

      await expect(extractFunctions(filePath)).rejects.toThrow(
        /Failed to parse file .*malformed\.js: syntax errors present/,
      );
    });

    it("throws when file has syntax errors", async () => {
      const filePath = await createTestFile(
        "syntax-error.js",
        `function test() {
  let x = ;
  return x;
}`,
      );

      await expect(extractFunctions(filePath)).rejects.toThrow(
        /Failed to parse file .*syntax-error\.js: syntax errors present/,
      );
    });
  });

  describe("edge cases", () => {
    it("handles nested function declarations", async () => {
      const filePath = await createTestFile(
        "nested.js",
        `function outer() {
  function inner() {
    return "inner";
  }
  return inner();
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.name).sort()).toEqual(["inner", "outer"]);
    });

    it("handles functions in different scopes", async () => {
      const filePath = await createTestFile(
        "scopes.js",
        `function global() {}

if (true) {
  function blockScope() {}
}

{
  function anotherBlock() {}
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result.some((f) => f.name === "global")).toBe(true);
    });

    it("handles very long function names", async () => {
      const longName = "a".repeat(500);
      const filePath = await createTestFile(
        "long-name.js",
        `function ${longName}() {
  return true;
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe(longName);
    });

    it("handles very large file", async () => {
      const functions = Array.from(
        { length: 1000 },
        (_, i) => `function func${i}() { return ${i}; }`,
      ).join("\n\n");

      const filePath = await createTestFile("large.js", functions);

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1000);
      expect(result[0].name).toBe("func0");
      expect(result[999].name).toBe("func999");
    });

    it("preserves exact function code including formatting", async () => {
      const code = `function   spaced  ()   {
    return     "weird spacing"  ;
  }`;
      const filePath = await createTestFile("formatting.js", code);

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(1);
      expect(result[0].code).toBe(code.trim());
    });

    it("handles functions with same name in nested scopes", async () => {
      const filePath = await createTestFile(
        "duplicate-names.js",
        `function test() {
  function test() {
    return "nested";
  }
  return test();
}`,
      );

      const result = await extractFunctions(filePath);

      expect(result).toHaveLength(2);
      expect(result.every((f) => f.name === "test")).toBe(true);
    });
  });
});
