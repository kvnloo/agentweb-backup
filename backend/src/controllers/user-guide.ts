import { Request, Response } from "express";
import { getNotionCredentials } from "../services/notionService";

export const getUserGuide = async (req: Request, res: Response) => {
  try {
    const { userGuidePageId } = await getNotionCredentials();
    // Strip dashes from the page ID for the Notion embed URL
    const pageIdNoDashes = userGuidePageId.replace(/-/g, "");
    res.status(200).json({
      success: true,
      data: { notionPageId: pageIdNoDashes },
    });
  } catch (error) {
    console.error("Error fetching user guide config:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user guide configuration",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
