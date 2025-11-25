import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { bookDb, Book, BookAttachment, Section, Chapter } from "../services/bookDb";
import { bookContentDb } from "../services/bookContentDb";
import { S3 } from "aws-sdk";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

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
      coverImageUrl,
      tags,
      status,
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

    const bookData: Omit<Book, "bookId" | "createdAt" | "updatedAt"> = {
      userId,
      title: title.trim(),
      description: description?.trim() || "",
      content: content || "",
      type,
      author: author.trim(),
      coverImageUrl: coverImageUrl || undefined,
      attachments: [],
      tags: tags && Array.isArray(tags) ? tags : [],
      status: status || "draft",
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
      coverImageUrl,
      tags,
      status,
    } = req.body;

    const updates: Partial<Book> = {};

    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description?.trim() || "";
    if (content !== undefined) updates.content = content;
    if (type !== undefined) {
      if (type !== "book" && type !== "whitepaper") {
        return res.status(400).json({ error: "Type must be 'book' or 'whitepaper'" });
      }
      updates.type = type;
    }
    if (author !== undefined) updates.author = author.trim();
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
    const { title, description, order, content } = req.body;

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
    if (content !== undefined) {
      await bookContentDb.createOrUpdateContent(bookId, userId, {
        sectionId,
        content,
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
    const { title, description, order, content } = req.body;

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
    if (content !== undefined) {
      await bookContentDb.createOrUpdateContent(bookId, userId, {
        sectionId,
        chapterId,
        content,
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

