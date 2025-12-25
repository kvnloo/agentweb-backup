import { Response, Router } from "express";
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
const withAuth = (
  handler: (req: AuthenticatedRequest, res: Response) => Promise<Response | void>
) => (req: any, res: Response) => handler(req as AuthenticatedRequest, res);

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
router.get("/", authenticateToken, withAuth(getBooks));

// Get single book by ID
router.get("/:bookId", authenticateToken, withAuth(getBookById));

// Create new book
router.post("/", authenticateToken, withAuth(createBook));

// Update book
router.put("/:bookId", authenticateToken, withAuth(updateBook));

// Delete book
router.delete("/:bookId", authenticateToken, withAuth(deleteBook));

// Publish/unpublish book
router.put("/:bookId/publish", authenticateToken, withAuth(publishBook));
router.post("/:bookId/export", authenticateToken, withAuth(exportBook));

// Upload file attachment (cover image or document)
router.post(
  "/:bookId/upload",
  authenticateToken,
  upload.single("file"),
  withAuth(uploadBookFile)
);

// Section management
router.post("/:bookId/sections", authenticateToken, withAuth(addSection));
router.put("/:bookId/sections/:sectionId", authenticateToken, withAuth(updateSection));
router.delete("/:bookId/sections/:sectionId", authenticateToken, withAuth(deleteSection));

// Chapter management
router.post("/:bookId/sections/:sectionId/chapters", authenticateToken, withAuth(addChapter));
router.put("/:bookId/sections/:sectionId/chapters/:chapterId", authenticateToken, withAuth(updateChapter));
router.delete("/:bookId/sections/:sectionId/chapters/:chapterId", authenticateToken, withAuth(deleteChapter));

// Content management
router.get("/:bookId/sections/:sectionId/content", authenticateToken, withAuth(getSectionContent));
router.get("/:bookId/sections/:sectionId/chapters/:chapterId/content", authenticateToken, withAuth(getChapterContent));

// Agent Mode session management
router.get("/:bookId/sections/:sectionId/session", authenticateToken, withAuth(getBookContentSession));
router.get("/:bookId/sections/:sectionId/chapters/:chapterId/session", authenticateToken, withAuth(getBookContentSession));
router.put("/:bookId/sections/:sectionId/session", authenticateToken, withAuth(updateBookContentSessionId));
router.put("/:bookId/sections/:sectionId/chapters/:chapterId/session", authenticateToken, withAuth(updateBookContentSessionId));

export default router;
