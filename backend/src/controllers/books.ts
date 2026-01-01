import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { bookDb, Book, BookAttachment, Section, Chapter, PREDEFINED_GENRES, BookExport } from "../services/bookDb";
import { bookContentDb } from "../services/bookContentDb";
import { S3 } from "aws-sdk";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import axios from "axios";
import sharp from "sharp";

const s3 = new S3();

// Helper function to upload file to S3
async function uploadBookFileToS3(
  file: Express.Multer.File,
  userId: string,
  bookId: string,
  fileType: string
): Promise<{ url: string; key: string }> {
  const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const key = `users/${userId}/books/${bookId}/${fileType}/${Date.now()}-${randomToken}-${
    file.originalname
  }`;

  await s3
    .putObject({
      Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
    .promise();

  // Properly encode the URL by encoding each path segment
  const bucket = process.env.AWS_S3_BUCKET || "agentweb-user-files";
  const region = process.env.AWS_REGION || "us-west-2";
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

  return { url, key };
}

// Map export config values to PDFKit options
const MARGIN_MAP: Record<string, number> = {
  narrow: 36, // 0.5 inch
  normal: 54, // ~0.75 inch
  wide: 72, // 1 inch
};

const MM_TO_PT = 72 / 25.4;

let markedModulePromise: Promise<any> | null = null;
async function getMarked() {
  if (!markedModulePromise) {
    // Use Function constructor to make import truly dynamic and avoid TypeScript static analysis
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    markedModulePromise = dynamicImport('marked');
  }
  return markedModulePromise;
}

async function fetchImageBuffer(url?: string): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer" });
    return Buffer.from(resp.data);
  } catch (err) {
    console.warn("Failed to fetch cover image", err);
    return null;
  }
}

function createTxtBuffer(
  book: Book,
  contents: Awaited<ReturnType<typeof bookContentDb.getAllBookContents>>
): Buffer {
  const isChinese = isChineseLanguage(book.language);
  const segments: string[] = [];
  const sortedSections =
    book.sections && book.sections.length > 0
      ? [...book.sections].sort((a, b) => a.order - b.order)
      : [];
  const contentLookup = new Map<string, string>();

  contents.forEach((c) => {
    const key = `${c.sectionId || ""}::${c.chapterId || ""}`;
    if (c.content) {
      contentLookup.set(key, c.content);
    }
  });

  const metadataLines: string[] = [];
  if (book.title) {
    metadataLines.push(`Title: ${book.title}`);
  }
  if (book.author) {
    metadataLines.push(`Author: ${book.author}`);
  }
  if (book.description) {
    metadataLines.push(`Description: ${book.description}`);
  }
  if (book.type) {
    metadataLines.push(`Type: ${book.type}`);
  }
  if (book.language) {
    metadataLines.push(`Language: ${book.language}`);
  }
  if (book.genre) {
    metadataLines.push(`Genre: ${book.genre}`);
  }
  if (book.tags && book.tags.length > 0) {
    metadataLines.push(`Tags: ${book.tags.join(", ")}`);
  }
  if (book.status) {
    metadataLines.push(`Status: ${book.status}`);
  }
  if (book.characters && book.characters.length > 0) {
    metadataLines.push("Characters:");
    book.characters.forEach((character) => {
      if (character.description) {
        metadataLines.push(`- ${character.name}: ${character.description}`);
      } else {
        metadataLines.push(`- ${character.name}`);
      }
    });
  }
  if (metadataLines.length > 0) {
    segments.push(...metadataLines, "");
  }

  if (sortedSections.length > 0) {
    sortedSections.forEach((section, sIdx) => {
      const sectionLabel = isChinese
        ? sIdx === 0
          ? `${section.title}`
          : `第${toChineseNumeral(sIdx)}章 ${section.title}`
        : `Section ${sIdx + 1}: ${section.title}`;
      segments.push(sectionLabel);
      if (section.description) {
        segments.push(section.description);
      }
      const sectionContent = contentLookup.get(`${section.sectionId}::`);
      if (sectionContent) {
        segments.push(sectionContent);
      }
      if (section.chapters && section.chapters.length > 0) {
        const sortedChapters = [...section.chapters].sort((a, b) => a.order - b.order);
        sortedChapters.forEach((chapter, cIdx) => {
          const chapterLabel = isChinese
            ? `${chapter.title}`
            : `Chapter ${cIdx + 1}: ${chapter.title}`;
          segments.push(chapterLabel);
          if (chapter.description) {
            segments.push(chapter.description);
          }
          const chapterContent = contentLookup.get(
            `${section.sectionId}::${chapter.chapterId}`
          );
          if (chapterContent) {
            segments.push(chapterContent);
          }
        });
      }
    });
  } else if (book.content) {
    segments.push(book.content);
  } else if (contents.length > 0) {
    [...contents]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .forEach((item) => {
        if (item.content) {
          segments.push(item.content);
        }
      });
  }

  const text = segments.filter(Boolean).join("\n\n").trim();
  return Buffer.from(text, "utf-8");
}

export function getPdfExportLayoutOptions(book: Book, exportConfig: any) {
  return {
    includeTableOfContents: book.type === "whitepaper" ? false : exportConfig?.includeTableOfContents !== false,
    showSectionTitlePage:
      book.type === "whitepaper"
        ? false
        : exportConfig?.showSectionTitlePage !== false,
  };
}

async function createPdfBuffer(
  book: Book,
  contents: Awaited<ReturnType<typeof bookContentDb.getAllBookContents>>,
  exportConfig: any
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const availableFonts = getAvailableFonts();
      const pageSize =
        exportConfig?.pageSize && typeof exportConfig.pageSize === "string"
          ? exportConfig.pageSize.toUpperCase()
          : "A4";
      const orientation =
        exportConfig?.orientation === "landscape" ? "landscape" : "portrait";
      const hasPerSideMargin =
        exportConfig?.marginTopMm !== undefined ||
        exportConfig?.marginBottomMm !== undefined ||
        exportConfig?.marginLeftMm !== undefined ||
        exportConfig?.marginRightMm !== undefined;

      const marginValue = MARGIN_MAP[exportConfig?.margin] ?? MARGIN_MAP["normal"];
      const margins = hasPerSideMargin
        ? {
            top:
              typeof exportConfig?.marginTopMm === "number"
                ? exportConfig.marginTopMm * MM_TO_PT
                : marginValue,
            bottom:
              typeof exportConfig?.marginBottomMm === "number"
                ? exportConfig.marginBottomMm * MM_TO_PT
                : marginValue,
            left:
              typeof exportConfig?.marginLeftMm === "number"
                ? exportConfig.marginLeftMm * MM_TO_PT
                : marginValue,
            right:
              typeof exportConfig?.marginRightMm === "number"
                ? exportConfig.marginRightMm * MM_TO_PT
                : marginValue,
          }
        : {
            top: marginValue,
            bottom: marginValue,
            left: marginValue,
            right: marginValue,
          };
      const fontSize =
        typeof exportConfig?.fontSize === "number" && exportConfig.fontSize > 6
          ? exportConfig.fontSize
          : 12;
      const lineHeight =
        typeof exportConfig?.lineHeight === "number" && exportConfig.lineHeight > 0
          ? exportConfig.lineHeight
          : 1.5;
      const includeCover = true; // always include cover page
      const { includeTableOfContents, showSectionTitlePage } = getPdfExportLayoutOptions(
        book,
        exportConfig
      );

      const doc = new PDFDocument({
        size: pageSize,
        layout: orientation,
        margins,
      });

      const buffers: Buffer[] = [];
      doc.on("data", (data) => buffers.push(data));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      // Map requested font to a safe built-in PDF font to avoid filesystem lookups
      // Register available fonts from fonts folder
      availableFonts.forEach((f) => {
        if (!f.data) return; // built-in font names don't need registration
        try {
          doc.registerFont(f.name, f.data);
        } catch (err) {
          console.warn(`Failed to register font ${f.name}`, err);
        }
      });

      const isChinese = isChineseLanguage(book.language);
      const requestedFont = (exportConfig?.fontFamily as string) || "";
      const matchedFont = availableFonts.find((f) => f.name === requestedFont);
      const bodyFont = matchedFont ? matchedFont.name : "Helvetica";
      const headingFont =
        !isChinese && !matchedFont ? "Helvetica-Bold" : bodyFont;
      const labelFont = headingFont;

      const isWhitepaper = book.type === "whitepaper";
      const theme = isWhitepaper
        ? {
            textColor: "#111827",
            mutedColor: "#6B7280",
            accentColor: "#0F172A",
          }
        : {
            textColor: "black",
            mutedColor: "black",
            accentColor: "black",
          };

      // Header/footer decorator (disabled for whitepaper to avoid blank header-only pages)
      let pageNumber = 0;
      const headerTitle = book.title || "Untitled";
      const applyPageDecorations = (options?: { skipHeader?: boolean }) => {
        if (isWhitepaper || options?.skipHeader) return;
        pageNumber += 1;
        const headerY = Math.max(16, doc.page.margins.top - 24);
        const footerY = doc.page.height - doc.page.margins.bottom + 12;
        const pageWidth =
          doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const currentY = doc.y;
        const currentX = doc.x;

        doc.save();
        doc
          .font(bodyFont)
          .fontSize(9)
          .fillColor(theme.mutedColor)
          .text(headerTitle, doc.page.margins.left, headerY, {
            width: pageWidth,
            align: "left",
          })
          .text(String(pageNumber), doc.page.margins.left, headerY, {
            width: pageWidth,
            align: "right",
          });
        doc
          .moveTo(doc.page.margins.left, headerY + 12)
          .lineTo(doc.page.margins.left + pageWidth, headerY + 12)
          .lineWidth(0.5)
          .strokeColor("#E5E7EB")
          .stroke();
        doc
          .font(bodyFont)
          .fontSize(9)
          .fillColor(theme.mutedColor)
          .text(isChinese ? "白皮书" : "White Paper", doc.page.margins.left, footerY, {
            width: pageWidth,
            align: "left",
          })
          .text(headerTitle, doc.page.margins.left, footerY, {
            width: pageWidth,
            align: "right",
          });
        doc.restore();
        doc.y = currentY;
        doc.x = currentX;
        doc.fillColor(theme.textColor);
        doc.font(bodyFont).fontSize(fontSize);
      };

      doc.font(bodyFont);
      doc.fontSize(fontSize);
      doc.fillColor(theme.textColor);
      const markPageUsed = () => {};

      const sortedSections =
        book.sections && book.sections.length > 0
          ? [...book.sections].sort((a, b) => a.order - b.order)
          : [];

      // Cover page (always included)
      if (includeCover) {
        const coverImageBuffer = await fetchImageBuffer(book.coverImageUrl);
        if (isWhitepaper) {
          const coverLeft = doc.page.margins.left;
          const coverTop = doc.page.margins.top;
          const coverWidth =
            doc.page.width - doc.page.margins.left - doc.page.margins.right;

          if (coverImageBuffer) {
            try {
              doc.image(coverImageBuffer, coverLeft, coverTop, {
                fit: [
                  doc.page.width - (doc.page.margins.left + doc.page.margins.right),
                  doc.page.height - (doc.page.margins.top + doc.page.margins.bottom),
                ],
                align: "center",
                valign: "center",
              });
              markPageUsed();
            } catch (err) {
              console.warn("Failed to render cover image for whitepaper, falling back to text", err);
              doc.text(book.title || "Untitled", { align: "center", underline: true });
              doc.moveDown(0.6);
              doc.text(`Author: ${book.author || "Unknown"}`, { align: "center" });
            }
          } else {
            let y = coverTop;
            doc
              .font(labelFont)
              .fontSize(12)
              .fillColor(theme.mutedColor)
              .text(isChinese ? "白皮书" : "WHITE PAPER", coverLeft, y, {
                width: coverWidth,
              });
            y = doc.y + 16;

            doc
              .font(headingFont)
              .fontSize(Math.max(fontSize + 16, 26))
              .fillColor(theme.textColor)
              .text(book.title || "Untitled", coverLeft, y, {
                width: coverWidth,
              });
            y = doc.y + 14;

            if (book.description) {
              doc
                .font(bodyFont)
                .fontSize(fontSize + 1)
                .fillColor(theme.mutedColor)
                .text(book.description, coverLeft, y, {
                  width: coverWidth,
                });
              y = doc.y + 18;
            }

            doc
              .font(bodyFont)
              .fontSize(fontSize)
              .fillColor(theme.textColor)
              .text(isChinese ? `作者: ${book.author || "Unknown"}` : `Author: ${book.author || "Unknown"}`, coverLeft, y, {
                width: coverWidth,
              });
            y = doc.y + 6;

            const locale = isChinese ? "zh-CN" : "en-US";
            const dateLabel = new Date().toLocaleDateString(locale, {
              year: "numeric",
              month: "long",
              day: "numeric",
            });
            doc
              .font(bodyFont)
              .fontSize(fontSize)
              .fillColor(theme.mutedColor)
              .text(isChinese ? `日期: ${dateLabel}` : `Date: ${dateLabel}`, coverLeft, y, {
                width: coverWidth,
              });

            doc.save();
            const lineY = doc.page.height - doc.page.margins.bottom - 36;
            doc
              .moveTo(coverLeft, lineY)
              .lineTo(coverLeft + coverWidth * 0.4, lineY)
              .lineWidth(2)
              .strokeColor(theme.accentColor)
              .stroke();
            doc.restore();
            doc.fillColor(theme.textColor).font(bodyFont).fontSize(fontSize);
            markPageUsed();
          }
        } else if (coverImageBuffer) {
          try {
            doc.image(coverImageBuffer, {
              fit: [
                doc.page.width - (doc.page.margins.left + doc.page.margins.right),
                doc.page.height - (doc.page.margins.top + doc.page.margins.bottom),
              ],
              align: "center",
              valign: "center",
            });
            markPageUsed();
          } catch (err) {
            console.warn("Failed to render cover image, falling back to text cover", err);
            doc.text(book.title || "Untitled", { align: "center", underline: true });
            doc.moveDown(0.6);
            doc.text(`Author: ${book.author || "Unknown"}`, { align: "center" });
            if (book.genre) {
              doc.moveDown(0.2);
              doc.text(`Genre: ${book.genre}`, { align: "center" });
            }
          }
        } else {
          doc.text(book.title || "Untitled", { align: "center", underline: true });
          doc.moveDown(0.6);
          doc.text(`Author: ${book.author || "Unknown"}`, { align: "center" });
          if (book.genre) {
            doc.moveDown(0.2);
            doc.text(`Genre: ${book.genre}`, { align: "center" });
          }
        }
        if (!isWhitepaper) {
          doc.addPage();
          applyPageDecorations();
        }
      }

      // Table of Contents (optional)
      if (includeTableOfContents && sortedSections.length > 0) {
        doc
          .font(headingFont)
          .fontSize(isWhitepaper ? fontSize + 6 : fontSize + 2)
          .fillColor(theme.textColor)
          .text(isChinese ? "目录" : isWhitepaper ? "Contents" : "Table of Contents", {
            align: isWhitepaper ? "left" : "center",
          });
        doc.moveDown(0.8);
        sortedSections.forEach((section, sIdx) => {
          const label = isChinese
            ? sIdx === 0
              ? `${section.title}`
              : `第${toChineseNumeral(sIdx)}章 ${section.title}`
            : isWhitepaper
              ? `${section.title}`
              : `Section ${sIdx + 1}: ${section.title}`;
          doc
            .font(bodyFont)
            .fontSize(fontSize)
            .fillColor(theme.textColor)
            .text(label, { lineGap: (lineHeight - 1) * fontSize });
          doc.moveDown(0.2);
          if (section.description) {
            doc
              .font(bodyFont)
              .fontSize(Math.max(fontSize - 1, 8))
              .fillColor(theme.mutedColor)
              .text(section.description, {
                indent: 8,
                lineGap: (lineHeight - 1) * (fontSize - 1),
              });
            doc.moveDown(0.2);
          }
          if (section.chapters?.length) {
            section.chapters
              .sort((a, b) => a.order - b.order)
              .forEach((chapter) => {
                const chapterLabel = isChinese
                  ? `${chapter.title}`
                  : `- ${chapter.title}`;
                doc
                  .font(bodyFont)
                  .fontSize(fontSize - 1)
                  .fillColor(theme.mutedColor)
                  .text(chapterLabel, {
                    indent: 12,
                    lineGap: (lineHeight - 1) * (fontSize - 1),
                  });
                if (chapter.description) {
                  doc
                    .font(bodyFont)
                    .fontSize(Math.max(fontSize - 2, 8))
                    .fillColor(theme.mutedColor)
                    .text(chapter.description, {
                      indent: 20,
                      lineGap: (lineHeight - 1) * (fontSize - 2),
                    });
                }
                doc.moveDown(0.1);
              });
          }
          doc.moveDown(0.8);
        });
        doc.addPage();
        applyPageDecorations();
      }

      const contentLookup = new Map<string, string>();
      contents.forEach((c) => {
        const key = `${c.sectionId || ""}::${c.chapterId || ""}`;
        if (c.content) {
          contentLookup.set(key, c.content);
        }
      });

      const hasRenderableSection = (section: Section) => {
        const sectionContent = contentLookup.get(`${section.sectionId}::`);
        const hasSectionContent = sectionContent && sectionContent.trim().length > 0;
        const hasChapterContent = section.chapters?.some((chapter) => {
          const chapterContent = contentLookup.get(
            `${section.sectionId}::${chapter.chapterId}`
          );
          return Boolean(chapterContent && chapterContent.trim().length > 0);
        });
        return Boolean(hasSectionContent || hasChapterContent);
      };

      const renderableSections = isWhitepaper
        ? sortedSections.filter((section) => hasRenderableSection(section))
        : sortedSections;

      const renderContentText = async (text: string) => {
        if (!text) return;
        await renderMarkdownToPdf(
          doc,
          text,
          fontSize,
          lineHeight,
          {
            bodyFont,
            headingFont,
            strongFont: headingFont,
            textColor: theme.textColor,
            headingColor: theme.accentColor,
          },
          markPageUsed
        );
        const bottomLimit = doc.page.height - doc.page.margins.bottom;
        const spacing = fontSize * lineHeight;
        if (doc.y + spacing < bottomLimit) {
          doc.moveDown();
        }
      };

      if (renderableSections.length > 0) {
        if (isWhitepaper) {
          for (let sIdx = 0; sIdx < renderableSections.length; sIdx++) {
            const section = renderableSections[sIdx];
            // Start each section on a fresh page
            doc.addPage();
            const safeSectionTitle =
              section.title && section.title.trim().length > 0
                ? section.title
                : `Section ${sIdx + 1}`;
            const sectionLabel = isChinese
              ? sIdx === 0
                ? `${safeSectionTitle}`
                : `第${toChineseNumeral(sIdx)}章 ${safeSectionTitle}`
              : `${safeSectionTitle}`;

            doc
              .font(headingFont)
              .fontSize(fontSize + 6)
              .fillColor(theme.accentColor)
              .text(sectionLabel);
            markPageUsed();
            doc.moveDown(0.4);
            doc.font(bodyFont).fontSize(fontSize).fillColor(theme.textColor);

            if (section.description) {
              doc
                .font(bodyFont)
                .fontSize(Math.max(fontSize - 1, 9))
                .fillColor(theme.mutedColor)
                .text(section.description, {
                  lineGap: (lineHeight - 1) * (fontSize - 1),
                });
              markPageUsed();
              doc.moveDown(0.6);
              doc.fillColor(theme.textColor).fontSize(fontSize);
            }

            const sectionContent = contentLookup.get(`${section.sectionId}::`);
            if (sectionContent) {
              await renderContentText(sectionContent);
            } else {
              doc.moveDown(0.4);
            }

            if (section.chapters && section.chapters.length > 0) {
              const sortedChapters = [...section.chapters].sort((a, b) => a.order - b.order);
              for (let cIdx = 0; cIdx < sortedChapters.length; cIdx++) {
                const chapter = sortedChapters[cIdx];
                const chapterLabel = isChinese
                  ? `${chapter.title}`
                  : `${chapter.title}`;
                doc
                  .font(headingFont)
                  .fontSize(fontSize + 2)
                  .fillColor(theme.textColor)
                  .text(chapterLabel);
                if (chapterLabel.trim().length > 0) {
                  markPageUsed();
                }
                doc.moveDown(0.4);
                doc.font(bodyFont).fontSize(fontSize).fillColor(theme.textColor);
                const chapterContent = contentLookup.get(
                  `${section.sectionId}::${chapter.chapterId}`
                );
                if (chapterContent) {
                  await renderContentText(chapterContent);
                } else {
                  doc.moveDown();
                }
              }
            }
          }
        } else {
          let firstSectionPageReady = !(includeCover || includeTableOfContents);
          for (let sIdx = 0; sIdx < renderableSections.length; sIdx++) {
            const section = renderableSections[sIdx];
            const sectionLabel = isChinese
              ? sIdx === 0
                ? `${section.title}`
                : `第${toChineseNumeral(sIdx)}章 ${section.title}`
              : `Section ${sIdx + 1}: ${section.title}`;

            if (showSectionTitlePage) {
              const sectionTitleFontSize = Math.max(fontSize * 2, fontSize + 10);

              // Section title page (dedicated)
              if (!firstSectionPageReady) {
                doc.addPage();
                applyPageDecorations();
                firstSectionPageReady = true;
              } else {
                doc.addPage();
                applyPageDecorations();
              }
              // Center the section title vertically and horizontally
              const titleY =
                doc.page.height / 2 -
                sectionTitleFontSize / 2 -
                (lineHeight - 1) * sectionTitleFontSize;
              const pageMarginLeft = doc.page.margins.left || 0;
              const pageMarginRight = doc.page.margins.right || 0;
              const usableWidth = doc.page.width - (pageMarginLeft + pageMarginRight);
              doc
                .fontSize(sectionTitleFontSize)
                .text(sectionLabel, pageMarginLeft, titleY, {
                  align: "center",
                  width: usableWidth,
                  underline: true,
                });
              doc.moveDown(2);

              // Section body page
              doc.addPage();
              applyPageDecorations();
            } else {
              if (!firstSectionPageReady) {
                doc.addPage();
                applyPageDecorations();
                firstSectionPageReady = true;
              } else {
                doc.addPage();
                applyPageDecorations();
              }
              doc.fontSize(fontSize + 2).text(sectionLabel);
              doc.moveDown(0.6);
            }

            const sectionContent = contentLookup.get(`${section.sectionId}::`);
            if (sectionContent) {
              await renderContentText(sectionContent);
            } else {
              doc.moveDown();
            }

            if (section.chapters && section.chapters.length > 0) {
              const sortedChapters = [...section.chapters].sort((a, b) => a.order - b.order);
              for (let cIdx = 0; cIdx < sortedChapters.length; cIdx++) {
                const chapter = sortedChapters[cIdx];
                const chapterLabel = isChinese
                  ? `${chapter.title}`
                  : `Chapter ${cIdx + 1}: ${chapter.title}`;
                doc.fontSize(fontSize + 1).text(chapterLabel);
                doc.moveDown(0.6);
                const chapterContent = contentLookup.get(
                  `${section.sectionId}::${chapter.chapterId}`
                );
                if (chapterContent) {
                  await renderContentText(chapterContent);
                } else {
                  doc.moveDown();
                }
              }
            }
          }
        }
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// Helper function to render an image in PDF
async function renderImageInPdf(
  doc: PDFKit.PDFDocument,
  imageUrl: string,
  altText: string,
  pageWidth: number,
  baseFontSize: number,
  lineGap: number,
  addSpacingBefore: boolean = true
) {
  try {
    const imageBuffer = await fetchImageBuffer(imageUrl);
    if (imageBuffer) {
      // Add spacing before image to prevent overlap with previous content
      if (addSpacingBefore) {
        doc.moveDown(0.5);
      }
      
      // Get actual image dimensions using sharp
      let imageWidth: number;
      let imageHeight: number;
      try {
        const metadata = await sharp(imageBuffer).metadata();
        imageWidth = metadata.width || 1;
        imageHeight = metadata.height || 1;
      } catch (sharpErr) {
        console.warn(`Failed to get image dimensions for ${imageUrl}, using defaults:`, sharpErr);
        imageWidth = 1;
        imageHeight = 1;
      }
      
      // Calculate available space on current page
      const currentY = doc.y;
      const pageHeight = doc.page.height;
      const topMargin = doc.page.margins.top;
      const bottomMargin = doc.page.margins.bottom;
      const availableHeight = pageHeight - topMargin - bottomMargin - (currentY - topMargin);
      
      // Reserve space for alt text (if any) and spacing after image
      const reservedSpace = altText && altText !== imageUrl ? 30 : 20; // Space for alt text + spacing
      
      const maxImageHeight = Math.max(150, availableHeight - reservedSpace);
      const widthScale = pageWidth / imageWidth;
      const heightScale = maxImageHeight / imageHeight;
      const scale = Math.min(widthScale, heightScale);
      let renderedWidth = imageWidth * scale;
      let renderedHeight = imageHeight * scale;

      // If not enough space for the image at max size, start a new page and recalc
      if (renderedHeight + reservedSpace > availableHeight) {
        doc.addPage();
        // Recalculate after page break
        const newY = doc.y;
        const newAvailableHeight = pageHeight - topMargin - bottomMargin - (newY - topMargin);
        const newMaxImageHeight = Math.max(150, newAvailableHeight - reservedSpace);
        const newHeightScale = newMaxImageHeight / imageHeight;
        const newScale = Math.min(widthScale, newHeightScale);
        renderedWidth = imageWidth * newScale;
        renderedHeight = imageHeight * newScale;
      }
      
      // Store Y position before image
      const yBeforeImage = doc.y;
      
      // Calculate X position to center the image
      const xPosition = doc.page.margins.left + (pageWidth - renderedWidth) / 2;
      
      // Embed the image at specific position and size
      doc.image(imageBuffer, xPosition, yBeforeImage, {
        width: renderedWidth,
        height: renderedHeight,
      });
      
      // Explicitly set Y position to after the image
      doc.y = yBeforeImage + renderedHeight;
      
      // Add alt text below image if available and different from URL
      if (altText && altText !== imageUrl) {
        doc.moveDown(0.3);
        doc.fontSize(Math.max(baseFontSize - 2, 8)).text(altText, {
          align: "center",
          lineGap: lineGap * 0.5,
        });
      }
      
      // Add spacing after image to prevent overlap with next content
      doc.moveDown(0.8);
      return true;
    } else {
      // Fallback: show alt text or URL
      if (addSpacingBefore) {
        doc.moveDown(0.5);
      }
      doc.fontSize(baseFontSize).text(`[Image: ${altText}]`, { lineGap });
      doc.moveDown(0.5);
      return false;
    }
  } catch (err) {
    console.warn(`Failed to load image ${imageUrl}:`, err);
    // Fallback: show alt text or URL
    if (addSpacingBefore) {
      doc.moveDown(0.5);
    }
    doc.fontSize(baseFontSize).text(`[Image: ${altText}]`, { lineGap });
    doc.moveDown(0.5);
    return false;
  }
}

// Render markdown into PDFKit with lightweight formatting
async function renderMarkdownToPdf(
  doc: PDFKit.PDFDocument,
  markdown: string,
  baseFontSize: number,
  lineHeight: number,
  theme?: {
    bodyFont?: string;
    headingFont?: string;
    strongFont?: string;
    textColor?: string;
    headingColor?: string;
  },
  onWrite?: () => void
) {
  const normalizedMarkdown = markdown
    .replace(/<\s*(strong|b)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '**$2**')
    .replace(/<\s*(em|i)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, '*$2*')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/__(.+?)__/g, '**$1**');
  const { marked } = await getMarked();
  const tokens = marked.lexer(normalizedMarkdown || "");
  const lineGap = (lineHeight - 1) * baseFontSize;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bodyFont = theme?.bodyFont;
  const headingFont = theme?.headingFont || bodyFont;
  const strongFont = theme?.strongFont || headingFont || bodyFont;
  const textColor = theme?.textColor;
  const headingColor = theme?.headingColor || textColor;
  const notifyWrite = () => {
    if (onWrite) onWrite();
  };

  const renderInlineTokens = (
    inlineTokens: any[],
    finalizeLine: boolean = true,
    layout?: { startX?: number; startY?: number; width?: number },
    state?: { first: boolean }
  ): boolean => {
    const renderState = state ?? { first: true };
    let endedLine = false;
    const writeText = (text: string, continued: boolean) => {
      const options: PDFKit.Mixins.TextOptions = { lineGap, continued };
      if (layout?.width !== undefined) {
        options.width = layout.width;
      }
      if (renderState.first && layout?.startX !== undefined && layout?.startY !== undefined) {
        if (text.length > 0) notifyWrite();
        doc.text(text, layout.startX, layout.startY, options);
        renderState.first = false;
        return;
      }
      if (text.length > 0) notifyWrite();
      doc.text(text, options);
      if (!continued) {
        endedLine = true;
      }
      renderState.first = false;
    };

    inlineTokens.forEach((inlineToken, idx) => {
      const isLast = idx === inlineTokens.length - 1;
      const finalizeCurrent = finalizeLine && isLast;
      const continued = !finalizeCurrent;
      switch (inlineToken.type) {
        case "strong":
          if (strongFont) {
            doc.font(strongFont);
          }
          if (inlineToken.tokens && Array.isArray(inlineToken.tokens)) {
            const innerEnded = renderInlineTokens(
              inlineToken.tokens,
              finalizeCurrent,
              layout,
              renderState
            );
            if (finalizeCurrent && innerEnded) {
              endedLine = true;
            }
          } else if (inlineToken.text) {
            writeText(inlineToken.text, continued);
          }
          if (bodyFont) {
            doc.font(bodyFont);
          }
          break;
        case "em":
          if (bodyFont) {
            doc.font(bodyFont);
          }
          if (inlineToken.tokens && Array.isArray(inlineToken.tokens)) {
            const innerEnded = renderInlineTokens(
              inlineToken.tokens,
              finalizeCurrent,
              layout,
              renderState
            );
            if (finalizeCurrent && innerEnded) {
              endedLine = true;
            }
          } else if (inlineToken.text) {
            writeText(inlineToken.text, continued);
          }
          break;
        case "link":
          if (bodyFont) {
            doc.font(bodyFont);
          }
          if (inlineToken.text) {
            writeText(inlineToken.text, continued);
          }
          break;
        case "codespan":
          if (bodyFont) {
            doc.font(bodyFont);
          }
          if (inlineToken.text) {
            writeText(inlineToken.text, continued);
          }
          break;
        case "br":
          writeText("", continued);
          break;
        default:
          if (bodyFont) {
            doc.font(bodyFont);
          }
          if (inlineToken.text) {
            writeText(inlineToken.text, continued);
          }
          break;
      }
      if (finalizeLine && isLast && !endedLine) {
        doc.text("", { continued: false });
        endedLine = true;
      }
    });
    return endedLine;
  };

  const collectInlineTokens = (tokens: any[] = []) => {
    const collected: any[] = [];
    tokens.forEach((token) => {
      if (token.type === "image") return;
      if (token.tokens && Array.isArray(token.tokens)) {
        collected.push(...token.tokens);
      } else if (token.text) {
        collected.push({ type: "text", text: token.text });
      }
    });
    return collected;
  };

  // Debug: log token types to understand structure
  // console.log("Tokens:", tokens.map((t: any) => ({ type: t.type, hasTokens: !!t.tokens, text: t.text?.substring(0, 50) })));

  // Process tokens and handle images
  if (bodyFont) {
    doc.font(bodyFont);
  }
  if (textColor) {
    doc.fillColor(textColor);
  }
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const headingToken = token as any;
        // Check for images in heading tokens
        if (headingToken.tokens && Array.isArray(headingToken.tokens)) {
          for (const subToken of headingToken.tokens) {
            if (subToken.type === "image") {
              const imageUrl = subToken.href || subToken.url || subToken.src;
              const altText = subToken.text || subToken.alt || subToken.title || "";
              if (imageUrl) {
                await renderImageInPdf(doc, imageUrl, altText, pageWidth, baseFontSize, lineGap, true);
                notifyWrite();
              }
            }
          }
        }
        const size = baseFontSize + Math.max(0, 4 - (headingToken as any).depth);
        if (headingFont) {
          doc.font(headingFont);
        }
        if (headingColor) {
          doc.fillColor(headingColor);
        }
        if ((headingToken as any).text) {
          notifyWrite();
        }
        doc.fontSize(size).text((headingToken as any).text, { lineGap });
        doc.moveDown(0.3);
        if (bodyFont) {
          doc.font(bodyFont);
        }
        if (textColor) {
          doc.fillColor(textColor);
        }
        doc.fontSize(baseFontSize);
        break;
      }
      case "paragraph": {
        const paraToken = token as any;
        // Check for images in paragraph tokens
        if (paraToken.tokens && Array.isArray(paraToken.tokens)) {
          // Check if paragraph contains only images (standalone images)
          const imageTokens = paraToken.tokens.filter((t: any) => t.type === "image");
          const textTokens = paraToken.tokens.filter((t: any) => t.type !== "image" && t.text && t.text.trim());
          const isImageOnly = imageTokens.length > 0 && textTokens.length === 0;

          // For standalone image paragraphs, add spacing before
          if (isImageOnly) {
            doc.moveDown(0.5);
          }
          const hasImages = imageTokens.length > 0;

          if (!hasImages) {
            if (bodyFont) {
              doc.font(bodyFont);
            }
            if (textColor) {
              doc.fillColor(textColor);
            }
            doc.fontSize(baseFontSize);
            renderInlineTokens(paraToken.tokens);
            doc.moveDown(0.5);
            break;
          }

          // Process tokens in order (text and images mixed), render text as a single flow
          let inlineBuffer: any[] = [];
          const flushInlineBuffer = () => {
            if (inlineBuffer.length === 0) return;
            if (bodyFont) {
              doc.font(bodyFont);
            }
            if (textColor) {
              doc.fillColor(textColor);
            }
            doc.fontSize(baseFontSize);
            renderInlineTokens(inlineBuffer);
            inlineBuffer = [];
          };

          for (let i = 0; i < paraToken.tokens.length; i++) {
            const subToken = paraToken.tokens[i];
            if (subToken.type === "image") {
              flushInlineBuffer();
              const imageUrl = subToken.href || subToken.url || subToken.src;
              const altText = subToken.text || subToken.alt || subToken.title || "";
              if (imageUrl) {
                // Don't add spacing before if it's the first token and we already added spacing for image-only paragraph
                const addSpacing = !(isImageOnly && i === 0);
                await renderImageInPdf(doc, imageUrl, altText, pageWidth, baseFontSize, lineGap, addSpacing);
                notifyWrite();
              }
              continue;
            }
            if (subToken.tokens && Array.isArray(subToken.tokens)) {
              inlineBuffer.push(...subToken.tokens);
            } else if (subToken.text && subToken.text.trim()) {
              inlineBuffer.push({ type: "text", text: subToken.text });
            }
          }

          flushInlineBuffer();

          // Add spacing after paragraph if it had content
          if (paraToken.tokens.length > 0) {
            // For image-only paragraphs, spacing is already handled by renderImageInPdf
            if (!isImageOnly) {
              doc.moveDown(0.5);
            }
          }
        } else if (paraToken.text && paraToken.text.trim()) {
          // Only render text if it's not empty
          if (bodyFont) {
            doc.font(bodyFont);
          }
          if (textColor) {
            doc.fillColor(textColor);
          }
          notifyWrite();
          doc.fontSize(baseFontSize).text(paraToken.text, { lineGap });
          doc.moveDown(0.5);
        }
        break;
      }
      case "list": {
        const listToken = token as any;
        for (let idx = 0; idx < listToken.items.length; idx++) {
          const item = listToken.items[idx];
          const bullet = listToken.ordered ? `${idx + 1}.` : "•";
          // Check for images in list items
          if (item.tokens && Array.isArray(item.tokens)) {
            // Process tokens in order
            if (bodyFont) {
              doc.font(bodyFont);
            }
            if (textColor) {
              doc.fillColor(textColor);
            }
            const inlineTokens = collectInlineTokens(item.tokens);
            if (inlineTokens.length === 0 && item.text) {
              inlineTokens.push({ type: "text", text: item.text });
            }
            notifyWrite();
            doc.text(`${bullet} `, { lineGap, width: pageWidth, continued: true });
            renderInlineTokens(inlineTokens, true);
          } else {
            if (bodyFont) {
              doc.font(bodyFont);
            }
            if (textColor) {
              doc.fillColor(textColor);
            }
            notifyWrite();
            doc.text(`${bullet} ${item.text}`, { lineGap });
          }
        }
        doc.moveDown(0.5);
        break;
      }
      case "code":
        if (bodyFont) {
          doc.font(bodyFont);
        }
        if (textColor) {
          doc.fillColor(textColor);
        }
        notifyWrite();
        doc.fontSize(baseFontSize - 1).text((token as any).text, { lineGap });
        doc.moveDown(0.5);
        doc.fontSize(baseFontSize);
        break;
      case "image": {
        const imageToken = token as any;
        // Handle different possible property names for image URL
        const imageUrl = imageToken.href || imageToken.url || imageToken.src;
        const altText = imageToken.text || imageToken.alt || imageToken.title || "";
        if (imageUrl) {
          await renderImageInPdf(doc, imageUrl, altText, pageWidth, baseFontSize, lineGap, true);
          notifyWrite();
        } else {
          console.warn("Image token found but no URL:", imageToken);
          doc.moveDown(0.5);
          notifyWrite();
          doc.fontSize(baseFontSize).text(`[Image: ${altText || "Image"}]`, { lineGap });
          doc.moveDown(0.5);
        }
        break;
      }
      case "space":
        doc.moveDown(0.5);
        break;
      default:
        break;
    }
  }
}

interface AvailableFont {
  name: string;
  data?: Buffer; // built-in fonts won't have data
}

let cachedFonts: AvailableFont[] | null = null;

function getAvailableFonts(): AvailableFont[] {
  if (cachedFonts) return cachedFonts;

  const entries: AvailableFont[] = [];
  const seen = new Set<string>();

  // Load custom fonts from repository folder
  const fontsDir = path.join(__dirname, "..", "fonts");
  try {
    const files = fs.readdirSync(fontsDir);
    files.forEach((file) => {
      const lower = file.toLowerCase();
      if (!lower.endsWith(".otf") && !lower.endsWith(".ttf")) return;
      const fullPath = path.join(fontsDir, file);
      try {
        const data = fs.readFileSync(fullPath);
        const name = path.basename(file, path.extname(file));
        if (!seen.has(name)) {
          entries.push({ name, data });
          seen.add(name);
        }
      } catch (err) {
        console.warn(`Failed to load font file ${file}`, err);
      }
    });
  } catch (err) {
    console.warn("Could not read fonts directory:", err);
  }

  // Load common system fonts if present
  const systemFonts = loadSystemFonts();
  systemFonts.forEach((font) => {
    if (!seen.has(font.name)) {
      entries.push(font);
      seen.add(font.name);
    }
  });

  // Add built-in PDFKit fonts for selection if not already present
  const builtIns = ["Helvetica", "Times-Roman", "Courier"];
  builtIns.forEach((name) => {
    if (!seen.has(name)) {
      entries.push({ name }); // no data needed for built-ins
      seen.add(name);
    }
  });

  cachedFonts = entries;
  return cachedFonts;
}

function isChineseLanguage(language?: string): boolean {
  if (!language) return false;
  const lower = language.toLowerCase();
  return (
    lower.includes("chinese") ||
    lower.startsWith("zh") ||
    lower.includes("cn") ||
    lower.includes("中文") ||
    lower.includes("汉")
  );
}

function toChineseNumeral(num: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (num <= 0) return num.toString();
  if (num <= 10) {
    if (num === 10) return "十";
    return digits[num];
  }
  if (num < 20) {
    return `十${digits[num - 10]}`;
  }
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    return ones === 0 ? `${digits[tens]}十` : `${digits[tens]}十${digits[ones]}`;
  }
  return num.toString(); // fallback for larger numbers
}

function loadSystemFonts(): AvailableFont[] {
  const candidates: { name: string; files: string[] }[] = [
    { name: "Times New Roman", files: ["Times New Roman.ttf", "TimesNewRoman.ttf"] },
    { name: "Arial", files: ["Arial.ttf"] },
    { name: "Georgia", files: ["Georgia.ttf"] },
    { name: "Garamond", files: ["Garamond.ttf"] },
  ];

  const searchDirs = [
    "/System/Library/Fonts",
    "/Library/Fonts",
    process.env.HOME ? path.join(process.env.HOME, "Library/Fonts") : null,
  ].filter(Boolean) as string[];

  const found: AvailableFont[] = [];
  const seen = new Set<string>();

  for (const { name, files } of candidates) {
    if (seen.has(name)) continue;
    let matched: Buffer | null = null;
    for (const dir of searchDirs) {
      for (const file of files) {
        const full = path.join(dir, file);
        if (fs.existsSync(full)) {
          try {
            matched = fs.readFileSync(full);
            break;
          } catch (err) {
            console.warn(`Failed to read system font ${full}`, err);
          }
        }
      }
      if (matched) break;
    }
    if (matched) {
      found.push({ name, data: matched });
      seen.add(name);
    }
  }

  return found;
}

// Get predefined genres (public endpoint)
export async function getPredefinedGenres(req: any, res: Response) {
  try {
    res.json({ success: true, data: PREDEFINED_GENRES });
  } catch (error) {
    console.error("Error fetching predefined genres:", error);
    res.status(500).json({ error: "Failed to fetch predefined genres" });
  }
}

// Get all books for authenticated user
export async function getBooks(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    const { type, status } = req.query;

    const filters: {
      type?: "book" | "whitepaper";
      status?: "draft" | "published" | "archived";
    } = {};

    if (type === "book" || type === "whitepaper") {
      filters.type = type;
    }

    if (status === "draft" || status === "published" || status === "archived") {
      filters.status = status;
    }

    const books = await bookDb.getBooksByUser(userId, filters);

    res.json({ success: true, data: books });
  } catch (error) {
    console.error("Error fetching books:", error);
    res.status(500).json({ error: "Failed to fetch books" });
  }
}

// Get single book by ID
export async function getBookById(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId) {
      return res.status(400).json({ error: "Book ID is required" });
    }

    const book = await bookDb.getBookById(bookId, userId);

    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Load all contents for this book
    const contents = await bookContentDb.getAllBookContents(bookId, userId);
    
    // Attach contents to sections and chapters
    if (book.sections) {
      for (const section of book.sections) {
        const sectionContent = contents.find(
          (c) => c.sectionId === section.sectionId && !c.chapterId
        );
        if (sectionContent) {
          section.content = sectionContent.content;
        }
        
        for (const chapter of section.chapters) {
          const chapterContent = contents.find(
            (c) => c.sectionId === section.sectionId && c.chapterId === chapter.chapterId
          );
          if (chapterContent) {
            chapter.content = chapterContent.content;
          }
        }
      }
    }

    res.json({ success: true, data: book });
  } catch (error) {
    console.error("Error fetching book:", error);
    res.status(500).json({ error: "Failed to fetch book" });
  }
}

// Create new book
export async function createBook(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    const {
      title,
      description,
      content,
      type,
      author,
      language,
      genre,
      coverImageUrl,
      tags,
      status,
      characters,
    } = req.body;

    // Validation
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    if (!type || (type !== "book" && type !== "whitepaper")) {
      return res.status(400).json({ error: "Type must be 'book' or 'whitepaper'" });
    }

    if (!author || !author.trim()) {
      return res.status(400).json({ error: "Author is required" });
    }

    // Set genre only for books, default to "Other" if not provided
    const bookGenre = type === "book" ? (genre?.trim() || "Other") : undefined;

    // Validate characters if provided (books only)
    if (type === "book" && characters !== undefined) {
      if (!Array.isArray(characters)) {
        return res.status(400).json({ error: "Characters must be an array" });
      }
      for (const char of characters) {
        if (!char.name || !char.name.trim()) {
          return res.status(400).json({ error: "Each character must have a name" });
        }
        if (!char.description || !char.description.trim()) {
          return res.status(400).json({ error: "Each character must have a description" });
        }
      }
    }

    const bookData: Omit<Book, "bookId" | "createdAt" | "updatedAt"> = {
      userId,
      title: title.trim(),
      description: description?.trim() || "",
      content: content || "",
      type,
      author: author.trim(),
      language: language || "English",
      genre: bookGenre,
      coverImageUrl: coverImageUrl || undefined,
      attachments: [],
      tags: tags && Array.isArray(tags) ? tags : [],
      characters:
        type === "book" && characters && Array.isArray(characters)
          ? characters.map((c: any) => ({
              name: c.name.trim(),
              description: c.description.trim(),
            }))
          : type === "book"
            ? []
            : undefined,
      status: status || "draft",
      exports: [],
    };

    const book = await bookDb.createBook(bookData);

    res.status(201).json({ success: true, data: book });
  } catch (error) {
    console.error("Error creating book:", error);
    res.status(500).json({ error: "Failed to create book" });
  }
}

// Update book
export async function updateBook(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId) {
      return res.status(400).json({ error: "Book ID is required" });
    }

    const {
      title,
      description,
      content,
      type,
      author,
      language,
      genre,
      coverImageUrl,
      tags,
      status,
      characters,
    } = req.body;

    // Get existing book to check current type (needed for genre validation)
    const existingBook = await bookDb.getBookById(bookId, userId);
    if (!existingBook) {
      return res.status(404).json({ error: "Book not found" });
    }

    const currentType = (type || existingBook.type) as "book" | "whitepaper";

    // Validate characters if provided (books only)
    if (currentType === "book" && characters !== undefined) {
      if (!Array.isArray(characters)) {
        return res.status(400).json({ error: "Characters must be an array" });
      }
      for (const char of characters) {
        if (!char.name || !char.name.trim()) {
          return res.status(400).json({ error: "Each character must have a name" });
        }
        if (!char.description || !char.description.trim()) {
          return res.status(400).json({ error: "Each character must have a description" });
        }
      }
    }

    const updates: Partial<Book> = {};

    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description?.trim() || "";
    if (content !== undefined) updates.content = content;
    if (type !== undefined) {
      if (type !== "book" && type !== "whitepaper") {
        return res.status(400).json({ error: "Type must be 'book' or 'whitepaper'" });
      }
      updates.type = type;
      // If type changes to whitepaper, remove genre and characters; if changes to book and no genre provided, set to "Other"
      if (type === "whitepaper") {
        updates.genre = undefined;
        updates.characters = undefined;
      } else if (type === "book" && genre === undefined && !existingBook.genre) {
        // Only set default if genre wasn't explicitly provided and doesn't exist
        updates.genre = "Other";
      }
    }
    if (author !== undefined) updates.author = author.trim();
    if (language !== undefined) updates.language = language;
    if (genre !== undefined) {
      // Only allow genre for books
      const currentType = updates.type || existingBook.type;
      if (currentType === "book") {
        updates.genre = genre.trim() || "Other";
      } else {
        updates.genre = undefined;
      }
    }
    if (characters !== undefined) {
      if (currentType === "book") {
        updates.characters = characters.map((c: any) => ({
          name: c.name.trim(),
          description: c.description.trim(),
        }));
      } else {
        updates.characters = undefined;
      }
    }
    if (coverImageUrl !== undefined) updates.coverImageUrl = coverImageUrl || undefined;
    if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : [];
    if (status !== undefined) {
      if (status !== "draft" && status !== "published" && status !== "archived") {
        return res.status(400).json({ error: "Status must be 'draft', 'published', or 'archived'" });
      }
      updates.status = status;
    }

    const updatedBook = await bookDb.updateBook(bookId, userId, updates);

    if (!updatedBook) {
      return res.status(404).json({ error: "Book not found" });
    }

    res.json({ success: true, data: updatedBook });
  } catch (error) {
    console.error("Error updating book:", error);
    res.status(500).json({ error: "Failed to update book" });
  }
}

// Delete book
export async function deleteBook(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId) {
      return res.status(400).json({ error: "Book ID is required" });
    }

    // Check if book exists and belongs to user
    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Delete all book contents
    await bookContentDb.deleteAllBookContents(bookId, userId);

    // Delete attachments from S3
    if (book.attachments && book.attachments.length > 0) {
      const deletePromises = book.attachments.map((attachment) =>
        s3
          .deleteObject({
            Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
            Key: attachment.key,
          })
          .promise()
      );
      await Promise.all(deletePromises);
    }

    // Delete cover image if exists
    if (book.coverImageUrl) {
      // Extract key from URL if possible
      const urlParts = book.coverImageUrl.split("/");
      const keyIndex = urlParts.findIndex((part) => part === "users");
      if (keyIndex !== -1) {
        const key = urlParts.slice(keyIndex).join("/");
        await s3
          .deleteObject({
            Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
            Key: key,
          })
          .promise();
      }
    }

    await bookDb.deleteBook(bookId, userId);

    res.json({ success: true, message: "Book deleted successfully" });
  } catch (error) {
    console.error("Error deleting book:", error);
    res.status(500).json({ error: "Failed to delete book" });
  }
}

// Publish/unpublish book
export async function publishBook(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId } = req.params;
    const { publish } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId) {
      return res.status(400).json({ error: "Book ID is required" });
    }

    if (typeof publish !== "boolean") {
      return res.status(400).json({ error: "Publish must be a boolean" });
    }

    const updatedBook = await bookDb.publishBook(bookId, userId, publish);

    if (!updatedBook) {
      return res.status(404).json({ error: "Book not found" });
    }

    res.json({ success: true, data: updatedBook });
  } catch (error) {
    console.error("Error publishing book:", error);
    res.status(500).json({ error: "Failed to publish book" });
  }
}

// Export book to PDF, upload to S3, and record export history
export async function exportBook(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId } = req.params;
    const exportConfig = req.body?.exportConfig || {};
    const requestedFormat =
      typeof exportConfig?.format === "string" ? exportConfig.format.toLowerCase() : "pdf";
    const exportFormat = requestedFormat === "txt" ? "txt" : "pdf";

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }
    if (!bookId) {
      return res.status(400).json({ error: "Book ID is required" });
    }

    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Fetch all stored contents for sections/chapters
    const contents = await bookContentDb.getAllBookContents(bookId, userId);

    const exportBuffer =
      exportFormat === "txt"
        ? createTxtBuffer(book, contents)
        : await createPdfBuffer(book, contents, exportConfig);
    const contentType =
      exportFormat === "txt" ? "text/plain; charset=utf-8" : "application/pdf";
    const extension = exportFormat === "txt" ? "txt" : "pdf";

    // Upload to S3 under exports folder
    const randomToken = uuidv4();
    const key = `users/${userId}/books/${bookId}/exports/${Date.now()}-${randomToken}.${extension}`;
    const bucket = process.env.AWS_S3_BUCKET || "agentweb-user-files";
    const region = process.env.AWS_REGION || "us-west-2";

    await s3
      .putObject({
        Bucket: bucket,
        Key: key,
        Body: exportBuffer,
        ContentType: contentType,
      })
      .promise();

    const encodedKey = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;

    const exportRecord: BookExport = {
      exportId: uuidv4(),
      url,
      key,
      format: exportFormat,
      ...(exportFormat === "pdf"
        ? {
            pageSize:
              typeof exportConfig?.pageSize === "string"
                ? exportConfig.pageSize.toUpperCase()
                : "A4",
            orientation:
              exportConfig?.orientation === "landscape" ? "landscape" : "portrait",
            fontFamily: exportConfig?.fontFamily,
            fontSize:
              typeof exportConfig?.fontSize === "number"
                ? exportConfig.fontSize
                : undefined,
          }
        : {}),
      createdAt: new Date().toISOString(),
    };

    const updatedExports = [...(book.exports || []), exportRecord];
    const updatedBook = await bookDb.updateBook(bookId, userId, {
      exports: updatedExports,
    });

    res.json({
      success: true,
      data: {
        export: exportRecord,
        exports: updatedExports,
        book: updatedBook,
        availableFonts: getAvailableFonts().map((f) => f.name),
      },
    });
  } catch (error) {
    console.error("Error exporting book:", error);
    res.status(500).json({ error: "Failed to export book" });
  }
}

// List available export fonts (from backend fonts folder)
export async function getExportFonts(req: any, res: Response) {
  try {
    const fonts = getAvailableFonts().map((f) => f.name);
    res.json({ success: true, data: fonts });
  } catch (error) {
    console.error("Error fetching export fonts:", error);
    res.status(500).json({ error: "Failed to fetch export fonts" });
  }
}

// Upload file attachment
export async function uploadBookFile(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const userId = req.user?.userId;
    const { bookId } = req.params;
    const file = req.file;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId) {
      return res.status(400).json({ error: "Book ID is required" });
    }

    if (!file) {
      return res.status(400).json({ error: "File is required" });
    }

    // Check if book exists and belongs to user
    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Determine file type - check if it's an image for cover, otherwise attachment
    const isImage = file.mimetype.startsWith("image/");
    const fileType = isImage ? "cover" : "attachment";
    const { url, key } = await uploadBookFileToS3(file, userId, bookId, fileType);

    // If it's a cover image, update coverImageUrl
    if (fileType === "cover") {
      await bookDb.updateBook(bookId, userId, {
        coverImageUrl: url,
      });
    } else {
      // Add to attachments array
      const attachments = book.attachments || [];
      const newAttachment: BookAttachment = {
        url,
        key,
        filename: file.originalname,
        type: file.mimetype,
        uploadedAt: new Date().toISOString(),
      };
      attachments.push(newAttachment);
      await bookDb.updateBook(bookId, userId, {
        attachments,
      });
    }

    res.json({
      success: true,
      data: {
        url,
        key,
        filename: file.originalname,
        type: file.mimetype,
      },
    });
  } catch (error) {
    console.error("Error uploading file:", error);
    res.status(500).json({ error: "Failed to upload file" });
  }
}

// Add section to book
export async function addSection(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId } = req.params;
    const { title, description, order } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId) {
      return res.status(400).json({ error: "Book ID is required" });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Section title is required" });
    }

    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    const sections = book.sections || [];
    const newSection: Section = {
      sectionId: uuidv4(),
      title: title.trim(),
      description: description?.trim() || "",
      order: order !== undefined ? order : sections.length,
      chapters: [],
    };

    sections.push(newSection);
    const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

    res.json({ success: true, data: updatedBook });
  } catch (error) {
    console.error("Error adding section:", error);
    res.status(500).json({ error: "Failed to add section" });
  }
}

// Update section
export async function updateSection(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId } = req.params;
    const { title, description, order, content, imagine } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId) {
      return res.status(400).json({ error: "Book ID and Section ID are required" });
    }

    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    const sections = book.sections || [];
    const sectionIndex = sections.findIndex((s) => s.sectionId === sectionId);
    if (sectionIndex === -1) {
      return res.status(404).json({ error: "Section not found" });
    }

    if (title !== undefined) sections[sectionIndex].title = title.trim();
    if (description !== undefined) sections[sectionIndex].description = description?.trim() || "";
    if (order !== undefined) sections[sectionIndex].order = order;

    // Save content to separate table if provided
    if (content !== undefined || imagine !== undefined) {
      await bookContentDb.createOrUpdateContent(bookId, userId, {
        sectionId,
        ...(content !== undefined && { content }),
        ...(imagine !== undefined && { imagine }),
      });
    }

    const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

    res.json({ success: true, data: updatedBook });
  } catch (error) {
    console.error("Error updating section:", error);
    res.status(500).json({ error: "Failed to update section" });
  }
}

// Delete section
export async function deleteSection(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId) {
      return res.status(400).json({ error: "Book ID and Section ID are required" });
    }

    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Delete section content and all chapter contents in this section
    const section = book.sections?.find((s) => s.sectionId === sectionId);
    if (section) {
      // Delete section content
      await bookContentDb.deleteContent(bookId, userId, sectionId);
      
      // Delete all chapter contents in this section
      for (const chapter of section.chapters) {
        await bookContentDb.deleteContent(bookId, userId, sectionId, chapter.chapterId);
      }
    }

    const sections = (book.sections || []).filter((s) => s.sectionId !== sectionId);
    const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

    res.json({ success: true, data: updatedBook });
  } catch (error) {
    console.error("Error deleting section:", error);
    res.status(500).json({ error: "Failed to delete section" });
  }
}

// Add chapter to section
export async function addChapter(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId } = req.params;
    const { title, description, order } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId) {
      return res.status(400).json({ error: "Book ID and Section ID are required" });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Chapter title is required" });
    }

    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    const sections = book.sections || [];
    const sectionIndex = sections.findIndex((s) => s.sectionId === sectionId);
    if (sectionIndex === -1) {
      return res.status(404).json({ error: "Section not found" });
    }

    const section = sections[sectionIndex];
    const newChapter: Chapter = {
      chapterId: uuidv4(),
      title: title.trim(),
      description: description?.trim() || "",
      order: order !== undefined ? order : section.chapters.length,
    };

    section.chapters.push(newChapter);
    const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

    res.json({ success: true, data: updatedBook });
  } catch (error) {
    console.error("Error adding chapter:", error);
    res.status(500).json({ error: "Failed to add chapter" });
  }
}

// Update chapter
export async function updateChapter(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId, chapterId } = req.params;
    const { title, description, order, content, imagine } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId || !chapterId) {
      return res.status(400).json({ error: "Book ID, Section ID, and Chapter ID are required" });
    }

    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    const sections = book.sections || [];
    const sectionIndex = sections.findIndex((s) => s.sectionId === sectionId);
    if (sectionIndex === -1) {
      return res.status(404).json({ error: "Section not found" });
    }

    const section = sections[sectionIndex];
    const chapterIndex = section.chapters.findIndex((c) => c.chapterId === chapterId);
    if (chapterIndex === -1) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    if (title !== undefined) section.chapters[chapterIndex].title = title.trim();
    if (description !== undefined) section.chapters[chapterIndex].description = description?.trim() || "";
    if (order !== undefined) section.chapters[chapterIndex].order = order;

    // Save content to separate table if provided
    if (content !== undefined || imagine !== undefined) {
      await bookContentDb.createOrUpdateContent(bookId, userId, {
        sectionId,
        chapterId,
        ...(content !== undefined && { content }),
        ...(imagine !== undefined && { imagine }),
      });
    }

    const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

    res.json({ success: true, data: updatedBook });
  } catch (error) {
    console.error("Error updating chapter:", error);
    res.status(500).json({ error: "Failed to update chapter" });
  }
}

// Delete chapter
export async function deleteChapter(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId, chapterId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId || !chapterId) {
      return res.status(400).json({ error: "Book ID, Section ID, and Chapter ID are required" });
    }

    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Delete chapter content
    await bookContentDb.deleteContent(bookId, userId, sectionId, chapterId);

    const sections = book.sections || [];
    const sectionIndex = sections.findIndex((s) => s.sectionId === sectionId);
    if (sectionIndex === -1) {
      return res.status(404).json({ error: "Section not found" });
    }

    const section = sections[sectionIndex];
    section.chapters = section.chapters.filter((c) => c.chapterId !== chapterId);
    const updatedBook = await bookDb.updateBook(bookId, userId, { sections });

    res.json({ success: true, data: updatedBook });
  } catch (error) {
    console.error("Error deleting chapter:", error);
    res.status(500).json({ error: "Failed to delete chapter" });
  }
}

// Get section content
export async function getSectionContent(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId) {
      return res.status(400).json({ error: "Book ID and Section ID are required" });
    }

    const content = await bookContentDb.getContent(bookId, userId, sectionId);

    if (!content) {
      return res.status(404).json({ error: "Content not found" });
    }

    res.json({ success: true, data: content });
  } catch (error) {
    console.error("Error fetching section content:", error);
    res.status(500).json({ error: "Failed to fetch section content" });
  }
}

// Get chapter content
export async function getChapterContent(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId, chapterId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId || !chapterId) {
      return res.status(400).json({ error: "Book ID, Section ID, and Chapter ID are required" });
    }

    const content = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);

    if (!content) {
      return res.status(404).json({ error: "Content not found" });
    }

    res.json({ success: true, data: content });
  } catch (error) {
    console.error("Error fetching chapter content:", error);
    res.status(500).json({ error: "Failed to fetch chapter content" });
  }
}

// Get existing session for book content (if it exists)
export async function getBookContentSession(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId, chapterId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId) {
      return res.status(400).json({ error: "Book ID and Section ID are required" });
    }

    // Verify book exists and belongs to user
    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Get existing content to check for sessionId
    const content = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);
    
    // If content exists and has a sessionId, try to get that session
    if (content?.sessionId) {
      const { chatbotDb } = await import("../services/chatbotService");
      try {
        const session = await chatbotDb.getChatSession(content.sessionId);
        if (session && session.userId === userId) {
          return res.json({ success: true, data: { session, content } });
        }
      } catch (error) {
        // Session doesn't exist, clear the sessionId
        await bookContentDb.updateSessionId(bookId, userId, sectionId, chapterId, null);
      }
    }

    // No existing session
    res.json({ success: true, data: { session: null, content: content || null } });
  } catch (error) {
    console.error("Error getting book content session:", error);
    res.status(500).json({ error: "Failed to get session" });
  }
}

// Update sessionId for book content
export async function updateBookContentSessionId(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { bookId, sectionId, chapterId } = req.params;
    const { sessionId } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!bookId || !sectionId) {
      return res.status(400).json({ error: "Book ID and Section ID are required" });
    }

    // Verify book exists and belongs to user
    const book = await bookDb.getBookById(bookId, userId);
    if (!book) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Create content entry if it doesn't exist, or update sessionId
    const existingContent = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);
    if (existingContent) {
      // Update only sessionId, preserve existing content
      await bookContentDb.updateSessionId(bookId, userId, sectionId, chapterId, sessionId || null);
    } else {
      // Create new content entry with sessionId
      await bookContentDb.createOrUpdateContent(bookId, userId, {
        sectionId,
        chapterId,
        content: "",
        sessionId: sessionId || undefined,
      });
    }

    const updatedContent = await bookContentDb.getContent(bookId, userId, sectionId, chapterId);

    res.json({ success: true, data: updatedContent });
  } catch (error) {
    console.error("Error updating book content session ID:", error);
    res.status(500).json({ error: "Failed to update session ID" });
  }
}
