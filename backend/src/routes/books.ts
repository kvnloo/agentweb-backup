import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import {
  getBooks,
  getBookById,
  createBook,
  updateBook,
  deleteBook,
  publishBook,
  uploadBookFile,
  addSection,
  updateSection,
  deleteSection,
  addChapter,
  updateChapter,
  deleteChapter,
  getSectionContent,
  getChapterContent,
  getBookContentSession,
  updateBookContentSessionId,
  getPredefinedGenres,
  exportBook,
  getExportFonts,
} from "../controllers/books";
import multer from "multer";

const router = Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit for books/whitepapers
  },
});

// Get predefined genres (public endpoint, no auth required)
router.get("/genres", getPredefinedGenres);
router.get("/export-fonts", getExportFonts);

// Get all books for authenticated user
router.get("/", authenticateToken, getBooks);

// Get single book by ID
router.get("/:bookId", authenticateToken, getBookById);

// Create new book
router.post("/", authenticateToken, createBook);

// Update book
router.put("/:bookId", authenticateToken, updateBook);

// Delete book
router.delete("/:bookId", authenticateToken, deleteBook);

// Publish/unpublish book
router.put("/:bookId/publish", authenticateToken, publishBook);
router.post("/:bookId/export", authenticateToken, exportBook);

// Upload file attachment (cover image or document)
router.post(
  "/:bookId/upload",
  authenticateToken,
  upload.single("file"),
  uploadBookFile
);

// Section management
router.post("/:bookId/sections", authenticateToken, addSection);
router.put("/:bookId/sections/:sectionId", authenticateToken, updateSection);
router.delete("/:bookId/sections/:sectionId", authenticateToken, deleteSection);

// Chapter management
router.post("/:bookId/sections/:sectionId/chapters", authenticateToken, addChapter);
router.put("/:bookId/sections/:sectionId/chapters/:chapterId", authenticateToken, updateChapter);
router.delete("/:bookId/sections/:sectionId/chapters/:chapterId", authenticateToken, deleteChapter);

// Content management
router.get("/:bookId/sections/:sectionId/content", authenticateToken, getSectionContent);
router.get("/:bookId/sections/:sectionId/chapters/:chapterId/content", authenticateToken, getChapterContent);

// Agent Mode session management
router.get("/:bookId/sections/:sectionId/session", authenticateToken, getBookContentSession);
router.get("/:bookId/sections/:sectionId/chapters/:chapterId/session", authenticateToken, getBookContentSession);
router.put("/:bookId/sections/:sectionId/session", authenticateToken, updateBookContentSessionId);
router.put("/:bookId/sections/:sectionId/chapters/:chapterId/session", authenticateToken, updateBookContentSessionId);

export default router;

