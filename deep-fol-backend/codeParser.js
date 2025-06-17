/**
 * Basic JavaScript Code Parser using Regular Expressions.
 * This parser is a best-effort approach for common, well-formatted JavaScript
 * and does not aim to be a full AST parser.
 */

/**
 * Finds the index of the matching closing brace for an opening brace.
 * @param {string} text The code text to search within.
 * @param {number} openBraceIndex The index of the opening brace '{'.
 * @returns {number} The index of the matching closing brace '}', or -1 if not found.
 */
function findClosingBrace(text, openBraceIndex) {
  let braceLevel = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === '{') {
      braceLevel++;
    } else if (text[i] === '}') {
      braceLevel--;
      if (braceLevel === 0) {
        return i;
      }
    }
  }
  return -1; // Should not happen in well-formed code
}

/**
 * Converts a character index in a file content string to a 1-based line number.
 * @param {string} fileContent The full content of the file.
 * @param {number} index The character index.
 * @returns {number} The 1-based line number.
 */
function getLineNumber(fileContent, index) {
  return (fileContent.substring(0, index).match(/\n/g) || []).length + 1;
}

/**
 * Extracts a summary from JSDoc or multi-line single comments.
 * @param {string | null} jsdocComment Full JSDoc comment block (e.g., "/** ... */").
 * @param {string | null} singleLineComments Concatenated single-line comments.
 * @returns {string | null} A summarized comment or null.
 */
function summarizeComment(jsdocComment, singleLineComments) {
  if (jsdocComment) {
    const lines = jsdocComment
      .replace(/^\s*\/\*\*!?/, '') // Remove "/**" or "/**!"
      .replace(/\*\/\s*$/, '')    // Remove "*/"
      .trim()
      .split('\n');
    let summary = '';
    for (const line of lines) {
      const cleanedLine = line.replace(/^\s*\*\s?/, '').trim(); // Remove leading "*"
      if (cleanedLine.startsWith('@')) break; // Stop at JSDoc tags
      if (cleanedLine) {
        summary += (summary ? ' ' : '') + cleanedLine;
        if (summary.length > 100 && summary.includes('.')) { // Heuristic: take first sentence if long
             summary = summary.substring(0, summary.indexOf('.') + 1);
             break;
        }
      } else if (summary) { // Empty line after some content might mean end of summary
          break;
      }
    }
    return summary.trim() || null;
  }
  if (singleLineComments) {
    const lines = singleLineComments.trim().split('\n');
    let summary = '';
    for (const line of lines) {
      const cleanedLine = line.replace(/^\s*\/\/\s?/, '').trim();
      if (cleanedLine) {
        summary += (summary ? ' ' : '') + cleanedLine;
         if (summary.length > 100 && summary.includes('.')) {
             summary = summary.substring(0, summary.indexOf('.') + 1);
             break;
        }
      } else if (summary) {
          break;
      }
    }
    return summary.trim() || null;
  }
  return null;
}


const CLASS_REGEX = /(?:\s*\/\*\*([\s\S]*?)\*\/\s*|\s*((?:\/\/[^\r\n]*\r?\n)+))?^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:extends\s+[A-Za-z_][A-Za-z0-9_.]+)?\s*\{/gm;
const FUNCTION_REGEX = /(?:\s*\/\*\*([\s\S]*?)\*\/\s*|\s*((?:\/\/[^\r\n]*\r?\n)+))?^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/gm;
// For methods, we apply this regex to the class body. Line numbers need to be offset.
const METHOD_REGEX = /(?:\s*\/\*\*([\s\S]*?)\*\/\s*|\s*((?:\/\/[^\r\n]*\r?\n)+))?^\s*(static\s+)?(async\s+|get\s+|set\s+)?(\*?\s*[A-Za-z_][A-Za-z0-9_]*|constructor)\s*\(([^)]*)\)\s*\{/gm;


// --- Import/Export Parsing Regexes ---
// Import default: import defaultName from 'source';
const IMPORT_DEFAULT_REGEX = /^\s*import\s+([A-Za-z_][A-Za-z0-9_$]*)\s+from\s+(['"])(.+?)\2\s*;?/gm;
// Import namespace: import * as namespaceName from 'source';
const IMPORT_NAMESPACE_REGEX = /^\s*import\s+\*\s+as\s+([A-Za-z_][A-Za-z0-9_$]*)\s+from\s+(['"])(.+?)\2\s*;?/gm;
// Import named: import { member1, member2 as alias2 } from 'source';
const IMPORT_NAMED_REGEX = /^\s*import\s+\{([^}]+)\}\s+from\s+(['"])(.+?)\2\s*;?/gm;
// Import side effect: import 'source';
const IMPORT_SIDE_EFFECT_REGEX = /^\s*import\s+(['"])(.+?)\1\s*;?/gm;

// Export default identifier: export default identifier;
const EXPORT_DEFAULT_IDENTIFIER_REGEX = /^\s*export\s+default\s+([A-Za-z_][A-Za-z0-9_$]*)\s*;?/gm;
// Export default expression (simplified, captures start of function/class or general expression)
const EXPORT_DEFAULT_EXPRESSION_REGEX = /^\s*export\s+default\s+(function(?:\s+[A-Za-z_][A-Za-z0-9_$]*)?\(|class(?:\s+[A-Za-z_][A-Za-z0-9_$]*)?\{|new\s+|[a-zA-Z_$][\w$]*\(|[{(["'`])\s*;?/gm;
// Export declaration: export const/let/var/function/class Name ...
const EXPORT_DECLARATION_REGEX = /^\s*export\s+(?:async\s+)?(const|let|var|function|class)\s+([A-Za-z_][A-Za-z0-9_$]*)/gm;
// Export named list: export { name1, name2 as alias }; or export { name1 } from 'source';
const EXPORT_NAMED_LIST_REGEX = /^\s*export\s+\{([^}]+)\}\s*(?:from\s+(['"])(.+?)\2)?\s*;?/gm;
// Export all from source: export * from 'source';
const EXPORT_ALL_FROM_REGEX = /^\s*export\s+\*\s+from\s+(['"])(.+?)\1\s*;?/gm;


/**
 * Parses import specifiers from a string like "member1, member2 as alias2".
 * @param {string} specifierString The string content between curly braces {}.
 * @returns {Array<Object>} Array of specifier objects.
 */
function parseImportSpecifiers(specifierString) {
  const specifiers = [];
  if (!specifierString || specifierString.trim() === "") return specifiers;
  specifierString.split(',').forEach(part => {
    const trimmedPart = part.trim();
    if (trimmedPart) {
      const aliasMatch = trimmedPart.match(/^([A-Za-z_][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_][A-Za-z0-9_$]*)$/);
      if (aliasMatch) {
        specifiers.push({ type: "named", imported: aliasMatch[1], local: aliasMatch[2] });
      } else {
        specifiers.push({ type: "named", imported: trimmedPart, local: trimmedPart });
      }
    }
  });
  return specifiers;
}

/**
 * Parses export specifiers from a string like "name1, name2 as alias".
 * @param {string} specifierString The string content between curly braces {}.
 * @returns {Array<Object>} Array of specifier objects.
 */
function parseExportSpecifiers(specifierString) {
  const specifiers = [];
   if (!specifierString || specifierString.trim() === "") return specifiers;
  specifierString.split(',').forEach(part => {
    const trimmedPart = part.trim();
    if (trimmedPart) {
      const aliasMatch = trimmedPart.match(/^([A-Za-z_][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_][A-Za-z0-9_$]*)$/);
      if (aliasMatch) {
        specifiers.push({ name: aliasMatch[2], local: aliasMatch[1] });
      } else {
        specifiers.push({ name: trimmedPart, local: trimmedPart });
      }
    }
  });
  return specifiers;
}


export function parseJavaScriptCode(fileContent, filePath) {
  const structures = [];
  const imports = [];
  const exports = [];
  let match;

  // Reset regex state for each call
  CLASS_REGEX.lastIndex = 0;
  FUNCTION_REGEX.lastIndex = 0;
  METHOD_REGEX.lastIndex = 0;
  IMPORT_DEFAULT_REGEX.lastIndex = 0;
  IMPORT_NAMESPACE_REGEX.lastIndex = 0;
  IMPORT_NAMED_REGEX.lastIndex = 0;
  IMPORT_SIDE_EFFECT_REGEX.lastIndex = 0;
  EXPORT_DEFAULT_IDENTIFIER_REGEX.lastIndex = 0;
  EXPORT_DEFAULT_EXPRESSION_REGEX.lastIndex = 0;
  EXPORT_DECLARATION_REGEX.lastIndex = 0;
  EXPORT_NAMED_LIST_REGEX.lastIndex = 0;
  EXPORT_ALL_FROM_REGEX.lastIndex = 0;

  // --- Parse Imports ---
  while ((match = IMPORT_DEFAULT_REGEX.exec(fileContent)) !== null) {
    const startLine = getLineNumber(fileContent, match.index);
    const endLine = getLineNumber(fileContent, match.index + match[0].length -1);
    imports.push({
      raw: match[0],
      source: match[3],
      specifiers: [{ type: "default", local: match[1] }],
      start_line: startLine, end_line: endLine, filePath
    });
  }
  while ((match = IMPORT_NAMESPACE_REGEX.exec(fileContent)) !== null) {
    const startLine = getLineNumber(fileContent, match.index);
    const endLine = getLineNumber(fileContent, match.index + match[0].length -1);
    imports.push({
      raw: match[0],
      source: match[3],
      specifiers: [{ type: "namespace", local: match[1] }],
      start_line: startLine, end_line: endLine, filePath
    });
  }
  while ((match = IMPORT_NAMED_REGEX.exec(fileContent)) !== null) {
    const startLine = getLineNumber(fileContent, match.index);
    const endLine = getLineNumber(fileContent, match.index + match[0].length -1);
    imports.push({
      raw: match[0],
      source: match[3],
      specifiers: parseImportSpecifiers(match[1]),
      start_line: startLine, end_line: endLine, filePath
    });
  }
  while ((match = IMPORT_SIDE_EFFECT_REGEX.exec(fileContent)) !== null) {
    const startLine = getLineNumber(fileContent, match.index);
    const endLine = getLineNumber(fileContent, match.index + match[0].length -1);
    imports.push({
      raw: match[0],
      source: match[2],
      specifiers: [{ type: "side-effect" }],
      start_line: startLine, end_line: endLine, filePath
    });
  }

  // --- Parse Exports ---
  while ((match = EXPORT_DEFAULT_IDENTIFIER_REGEX.exec(fileContent)) !== null) {
    const startLine = getLineNumber(fileContent, match.index);
    const endLine = getLineNumber(fileContent, match.index + match[0].length -1);
    exports.push({
      raw: match[0], type: "default",
      exported_items: [{ name: "default", local: match[1] }],
      source: null, start_line: startLine, end_line: endLine, filePath
    });
  }
  // EXPORT_DEFAULT_EXPRESSION_REGEX is tricky, often better to rely on raw for complex cases
  // For now, we'll primarily use it to mark that a default export expression exists.
  // A more sophisticated approach might try to determine if it's an anonymous func/class.
  while ((match = EXPORT_DEFAULT_EXPRESSION_REGEX.exec(fileContent)) !== null) {
      // Avoid double counting if EXPORT_DEFAULT_IDENTIFIER_REGEX already matched (e.g. export default foo;)
      if (exports.some(e => e.raw.startsWith(match[0].substring(0, Math.min(match[0].length, 20))))) continue;

      const startLine = getLineNumber(fileContent, match.index);
      // For expressions, end_line is harder with regex. Often it's single line or needs balancing.
      // For simplicity, we'll assume it's mostly single line or rely on the raw for full expression.
      const endOfStatement = fileContent.indexOf(';', match.index);
      const endOfLine = fileContent.indexOf('\n', match.index);
      let statementEndIndex = match.index + match[0].length -1;
      if (endOfStatement !== -1 && (endOfLine === -1 || endOfStatement < endOfLine)) {
          statementEndIndex = endOfStatement;
      } else if (endOfLine !== -1) {
          // Heuristic for expression ending at line end if no semicolon
          statementEndIndex = endOfLine;
      }
      // If it's a function or class declaration, findClosingBrace might be useful, but regex is simplified.
      const endLine = getLineNumber(fileContent, statementEndIndex);

      let localName = "anonymous_expression"; // Default for complex expressions
      if (match[0].includes("function")) localName = match[2] || "anonymous_function";
      else if (match[0].includes("class")) localName = match[3] || "anonymous_class";

      exports.push({
        raw: fileContent.substring(match.index, statementEndIndex + (fileContent[statementEndIndex] === ';' ? 1: 0) ),
        type: "default_expression",
        exported_items: [{ name: "default", local: localName }], // Simplified
        source: null, start_line: startLine, end_line: endLine, filePath
      });
  }

  while ((match = EXPORT_DECLARATION_REGEX.exec(fileContent)) !== null) {
    const startLine = getLineNumber(fileContent, match.index);
    // For declarations, end_line requires finding end of statement or block
    // This is simplified; structure parsing will get more accurate end_lines for func/class
    const endOfStatement = fileContent.indexOf(';', match.index);
    const endOfLine = fileContent.indexOf('\n', match.index);
    let statementEndIndex = match.index + match[0].length -1;
     if (match[1] === 'function' || match[1] === 'class') {
        const openBrace = fileContent.indexOf('{', match.index + match[0].length -1);
        if(openBrace !== -1) {
            const closeBrace = findClosingBrace(fileContent, openBrace);
            statementEndIndex = closeBrace !== -1 ? closeBrace : statementEndIndex;
        }
    } else if (endOfStatement !== -1 && (endOfLine === -1 || endOfStatement < endOfLine)) {
        statementEndIndex = endOfStatement;
    } else if (endOfLine !== -1) {
        statementEndIndex = endOfLine;
    }

    const endLine = getLineNumber(fileContent, statementEndIndex);
    exports.push({
      raw: fileContent.substring(match.index, statementEndIndex + (fileContent[statementEndIndex] === ';' ? 1: 0) ),
      type: "declaration",
      exported_items: [{ name: match[2], local: match[2] }],
      source: null, start_line: startLine, end_line: endLine, filePath
    });
  }
  while ((match = EXPORT_NAMED_LIST_REGEX.exec(fileContent)) !== null) {
    const startLine = getLineNumber(fileContent, match.index);
    const endLine = getLineNumber(fileContent, match.index + match[0].length -1);
    exports.push({
      raw: match[0],
      type: match[3] ? "re-export_named" : "named_list",
      exported_items: parseExportSpecifiers(match[1]),
      source: match[3] || null,
      start_line: startLine, end_line: endLine, filePath
    });
  }
  while ((match = EXPORT_ALL_FROM_REGEX.exec(fileContent)) !== null) {
    const startLine = getLineNumber(fileContent, match.index);
    const endLine = getLineNumber(fileContent, match.index + match[0].length -1);
    exports.push({
      raw: match[0], type: "re-export_all",
      exported_items: [{ name: "*", local: "*" }],
      source: match[2], start_line: startLine, end_line: endLine, filePath
    });
  }


  // Pass 1: Top-level classes and their methods
  while ((match = CLASS_REGEX.exec(fileContent)) !== null) {
    const jsdocComment = match[1];
    const singleLineComments = match[2];
    const className = match[3];
    const classStartIndex = match.index;
    const classHeaderEndIndex = match.index + match[0].length -1; // End of the matched header part "class Foo {"

    const startLine = getLineNumber(fileContent, classStartIndex);
    const classBodyStartIndex = classHeaderEndIndex + 1; // After the opening brace of class
    const classEndBraceIndex = findClosingBrace(fileContent, classHeaderEndIndex);

    if (classEndBraceIndex === -1) {
      console.warn(`[${filePath}] Could not find closing brace for class ${className} starting at line ${startLine}. Skipping.`);
      continue;
    }

    const endLine = getLineNumber(fileContent, classEndBraceIndex);
    const classCodeSnippet = fileContent.substring(classStartIndex, classEndBraceIndex + 1);
    const summary = summarizeComment(jsdocComment, singleLineComments);

    elements.push({
      type: 'class',
      name: className,
      filePath: filePath,
      signature: `class ${className} { ... }`, // Simplified signature
      summary: summary,
      code_snippet: classCodeSnippet,
      className: null,
      start_line: startLine,
      end_line: endLine,
    });

    const classBodyContent = fileContent.substring(classBodyStartIndex, classEndBraceIndex);
    let methodMatch;
    METHOD_REGEX.lastIndex = 0; // Reset for each class body

    while ((methodMatch = METHOD_REGEX.exec(classBodyContent)) !== null) {
      const methodJsdoc = methodMatch[1];
      const methodSingleLines = methodMatch[2];
      // methodMatch[3] is static, methodMatch[4] is async/get/set
      const methodFullName = (methodMatch[3] || "") + (methodMatch[4] || "") + methodMatch[5];
      const methodName = methodMatch[5].replace('*','').trim(); // Clean generator star
      const methodParams = methodMatch[6];

      const methodLocalStartIndex = methodMatch.index;
      const methodHeaderEndIndex = methodMatch.index + methodMatch[0].length -1;

      const methodActualStartIndex = classBodyStartIndex + methodLocalStartIndex;
      const methodActualHeaderEndIndex = classBodyStartIndex + methodHeaderEndIndex;

      const methodStartLine = getLineNumber(fileContent, methodActualStartIndex);
      const methodEndBraceIndex = findClosingBrace(fileContent, methodActualHeaderEndIndex);

      if (methodEndBraceIndex === -1) {
        console.warn(`[${filePath}] Could not find closing brace for method ${methodName} in class ${className} starting at line ${methodStartLine}. Skipping.`);
        continue;
      }

      const methodEndLine = getLineNumber(fileContent, methodEndBraceIndex);
      const methodCodeSnippet = fileContent.substring(methodActualStartIndex, methodEndBraceIndex + 1);
      const methodSummary = summarizeComment(methodJsdoc, methodSingleLines);

      elements.push({
        type: 'method',
        name: methodName,
        filePath: filePath,
        signature: `${methodFullName}(${methodParams})`,
        summary: methodSummary,
        code_snippet: methodCodeSnippet,
        className: className,
        start_line: methodStartLine,
        end_line: methodEndLine,
      });
    }
  }

  // Pass 2: Top-level functions (ensure they are not methods already processed by being inside a class snippet)
  // A more robust way would be to mark ranges covered by classes and skip functions within those.
  // For simplicity now, we assume regex won't pick up methods as top-level functions due to context.
  // This might need refinement if top-level functions can look very similar to methods structurally.
  while ((match = FUNCTION_REGEX.exec(fileContent)) !== null) {
    // Crude check: if this match is inside an already found class, skip it.
    // Also check if it's part of an export default function declaration that was already captured
    const funcStartIndexCheck = match.index;
    if (exports.some(e => e.raw.includes(match[0]) && e.raw.includes("export default function") && getLineNumber(fileContent, funcStartIndexCheck) === e.start_line)) {
        continue;
    }
    const funcStartIndex = match.index;
    let isInsideClass = false;
    for (const el of elements) {
        if (el.type === 'class' && funcStartIndex > el.start_line && funcStartIndex < el.end_line) { // Approx check by line
            const classStartCharIndex = fileContent.indexOf(el.code_snippet); // Not perfectly accurate if snippet is repeated
            const classEndCharIndex = classStartCharIndex + el.code_snippet.length;
            if (funcStartIndex > classStartCharIndex && funcStartIndex < classEndCharIndex) {
                 isInsideClass = true;
                 break;
            }
        }
    }
    if(isInsideClass) continue;


    const jsdocComment = match[1];
    const singleLineComments = match[2];
    const functionName = match[3];
    const functionParams = match[4];
    const functionHeaderEndIndex = match.index + match[0].length -1;

    const startLine = getLineNumber(fileContent, funcStartIndex);
    const functionEndBraceIndex = findClosingBrace(fileContent, functionHeaderEndIndex);

    if (functionEndBraceIndex === -1) {
      console.warn(`[${filePath}] Could not find closing brace for function ${functionName} starting at line ${startLine}. Skipping.`);
      continue;
    }

    const endLine = getLineNumber(fileContent, functionEndBraceIndex);
    const functionCodeSnippet = fileContent.substring(funcStartIndex, functionEndBraceIndex + 1);
    const summary = summarizeComment(jsdocComment, singleLineComments);

    elements.push({
      type: 'function',
      name: functionName,
      filePath: filePath,
      signature: `function ${functionName}(${functionParams})`,
      summary: summary,
      code_snippet: functionCodeSnippet,
      className: null,
      start_line: startLine,
      end_line: endLine,
    });
  }

  return { structures: elements, imports, exports };
}
