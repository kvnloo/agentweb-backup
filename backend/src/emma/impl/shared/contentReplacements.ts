/**
 * ENG-2103 (F2 pilot) — shared, stateless content-replacement engine.
 *
 * Extracted verbatim from `AgentModeService.prototype.performContentReplacements`
 * and `AgentModeService.prototype.performDirectReplacement`. Both were pure string
 * manipulation with zero `this`/instance-state dependency once you follow the call
 * graph one level down — the only reason they lived on the class at all was that
 * every other tool handler did too.
 *
 * Two callers share this logic: `updateHtmlFile` (still a class method — not part
 * of the F2 pilot cluster) and `updateBookContent` (moved to
 * `emma/impl/books.ts`). Promoting both functions here once, instead of
 * duplicating them into the new book module, is the same "pure helper -> standalone
 * module" treatment the F2 design draft's §3.2 prescribes for pure caches — it
 * applies equally to a pure helper function. `AgentModeService.prototype.*`
 * now delegates to these so there is exactly one implementation.
 */

/**
 * Replace `oldContent` with `newContent` inside `content`.
 *
 * For large old-content blobs (>1000 chars, i.e. a whole-file replacement) this
 * does an exact (or, with `exactMatch=false`, whitespace-normalized) string
 * comparison rather than a regex, since a regex built from a huge literal string
 * is both slow and easy to get wrong. For anything smaller it escapes the
 * literal and uses a global regex so every occurrence is counted and replaced
 * in one pass.
 */
export function performDirectReplacement(
  content: string,
  oldContent: string,
  newContent: string,
  exactMatch: boolean = true
): { content: string; changeCount: number } | null {
  try {
    // For entire file replacement (when oldContent is very large), use more flexible matching
    if (oldContent.length > 1000) {
      if (exactMatch) {
        // Use exact string comparison
        if (content === oldContent) {
          console.log(`AgentMode: Exact match found for entire file replacement`);
          return { content: newContent, changeCount: 1 };
        } else {
          console.warn(`Old content does not match exactly. Expected length: ${oldContent.length}, actual length: ${content.length}`);
          console.warn(`First 100 chars of expected: ${oldContent.substring(0, 100)}`);
          console.warn(`First 100 chars of actual: ${content.substring(0, 100)}`);
          return null;
        }
      } else {
        // Use normalized whitespace comparison for flexible matching
        const normalizedContent = content.replace(/\s+/g, ' ').trim();
        const normalizedOldContent = oldContent.replace(/\s+/g, ' ').trim();

        if (normalizedContent === normalizedOldContent) {
          console.log(`AgentMode: Normalized match found for entire file replacement`);
          return { content: newContent, changeCount: 1 };
        } else {
          // Try exact match as fallback
          if (content === oldContent) {
            console.log(`AgentMode: Exact match found for entire file replacement (fallback)`);
            return { content: newContent, changeCount: 1 };
          } else {
            console.warn(`Old content does not match even with normalization. Expected length: ${oldContent.length}, actual length: ${content.length}`);
            console.warn(`First 100 chars of expected: ${oldContent.substring(0, 100)}`);
            console.warn(`First 100 chars of actual: ${content.substring(0, 100)}`);
            return null;
          }
        }
      }
    }

    // For smaller content, use regex for more flexible matching
    const changeCount = (content.match(new RegExp(oldContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

    // Check if old content exists
    if (changeCount === 0) {
      console.warn(`Old content not found. Content length: ${content.length}, old content length: ${oldContent.length}`);
      return null;
    }

    // Perform replacement - replace all occurrences
    const updatedContent = content.replace(new RegExp(oldContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newContent);

    return { content: updatedContent, changeCount };

  } catch (error) {
    console.error('Error in direct replacement:', error);
    return null;
  }
}

/**
 * Validate and apply a batch of replacement instructions ("full" hash-verified
 * whole-content replacement, or "part" old_content/new_content replacements)
 * against `currentContent`. Shared by `update_html_file` and `update_book_content`.
 */
export function performContentReplacements(
  currentContent: string,
  currentContentHash: string,
  updateType: string,
  replacementInstructions: any[]
): { success: boolean; updatedContent?: string; replacementResults?: any[]; error?: any } {
  // Validate update_type
  if (!updateType || !['part', 'full'].includes(updateType)) {
    return {
      success: false,
      error: {
        message: 'update_type must be either "part" or "full"'
      }
    };
  }

  // Validate that replacementInstructions is an array
  if (!Array.isArray(replacementInstructions)) {
    return {
      success: false,
      error: {
        message: 'replacement_json must be an array of replacement instructions'
      }
    };
  }

  if (replacementInstructions.length === 0) {
    return {
      success: false,
      error: {
        message: 'At least one replacement instruction is required'
      }
    };
  }

  // Validate each replacement instruction based on update_type
  for (let i = 0; i < replacementInstructions.length; i++) {
    const instruction = replacementInstructions[i];

    if (instruction.new_content === undefined || instruction.expected_count === undefined) {
      return {
        success: false,
        error: {
          message: `Missing required fields in replacement instruction ${i + 1}: new_content and expected_count are required`
        }
      };
    }

    if (updateType === 'full') {
      // For full replacement, require old_content_hash
      if (!instruction.old_content_hash) {
        return {
          success: false,
          error: {
            message: `Replacement instruction ${i + 1} missing old_content_hash. For update_type="full", old_content_hash is required`
          }
        };
      }
      if (instruction.old_content !== undefined) {
        return {
          success: false,
          error: {
            message: `Replacement instruction ${i + 1} should not have old_content when update_type="full". Use hash instead`
          }
        };
      }
    } else if (updateType === 'part') {
      // For part replacement, require old_content
      if (!instruction.old_content) {
        return {
          success: false,
          error: {
            message: `Replacement instruction ${i + 1} missing old_content. For update_type="part", old_content is required`
          }
        };
      }
      if (instruction.old_content_hash !== undefined) {
        return {
          success: false,
          error: {
            message: `Replacement instruction ${i + 1} should not have old_content_hash when update_type="part". Use old_content instead`
          }
        };
      }
    }
  }

  let updatedContent = currentContent;
  const replacementResults = [];

  // Perform all replacements
  for (let i = 0; i < replacementInstructions.length; i++) {
    const instruction = replacementInstructions[i];
    const { new_content, expected_count } = instruction;

    if (updateType === 'full') {
      // Entire content replacement using hash
      const providedHash = instruction.old_content_hash;
      console.log(`AgentMode: Full replacement ${i + 1}: hash: ${providedHash}, new_content length: ${new_content.length}, expected_count: ${expected_count}`);

      // Verify that the provided hash matches the current content hash
      if (providedHash !== currentContentHash) {
        return {
          success: false,
          error: {
            message: `Replacement ${i + 1} failed: Content hash mismatch. Expected: ${currentContentHash}, provided: ${providedHash}. The content may have been modified since it was last read.`,
            suggestion: 'Use get_book_content or read_file_content to get the current content and hash, then retry the replacement',
            isHashMismatch: true // Flag for HTML file error message mapping
          }
        };
      }

      // For hash-based replacement, we replace the entire content
      if (expected_count === 1) {
        console.log(`AgentMode: Hash verification successful, replacing entire content`);
        updatedContent = new_content;
        replacementResults.push({
          index: i + 1,
          old_content_hash: instruction.old_content_hash,
          new_content: new_content,
          expected_count: expected_count,
          actual_count: 1,
          success: true
        });
      } else {
        return {
          success: false,
          error: {
            message: `Replacement ${i + 1} failed: Full replacement only supports expected_count of 1 (entire content replacement)`,
            suggestion: 'Use expected_count: 1 for full content replacement'
          }
        };
      }
    } else if (updateType === 'part') {
      // Partial content replacement using old_content
      const { old_content } = instruction;
      console.log(`AgentMode: Part replacement ${i + 1}: old_content length: ${old_content.length}, new_content length: ${new_content.length}, expected_count: ${expected_count}`);

      // Perform the replacement using the existing logic
      const replacementResult = performDirectReplacement(
        updatedContent,
        old_content,
        new_content,
        true // exact_match = true for partial replacements
      );

      if (replacementResult === null) {
        return {
          success: false,
          error: {
            message: `Replacement ${i + 1} failed: The old_content was not found in the content. No changes were made.`,
            suggestion: 'Check that the old_content exactly matches the content. Use get_book_content or read_file_content to retrieve the exact current content.'
          }
        };
      }

      // Check if the actual change count matches expected count
      if (replacementResult.changeCount !== expected_count) {
        return {
          success: false,
          error: {
            message: `Replacement ${i + 1} failed: Expected ${expected_count} occurrences of old_content, but found ${replacementResult.changeCount}. No changes were made.`,
            suggestion: 'Check the expected_count matches the actual number of occurrences in the content'
          }
        };
      }

      updatedContent = replacementResult.content;
      replacementResults.push({
        index: i + 1,
        old_content: old_content,
        new_content: new_content,
        expected_count: expected_count,
        actual_count: replacementResult.changeCount,
        success: true
      });
    }
  }

  return {
    success: true,
    updatedContent,
    replacementResults
  };
}
