import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { DynamoDB } from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import { S3 } from "aws-sdk";
import crypto from "crypto";

const router = Router();
const dynamodb = new DynamoDB.DocumentClient();
const s3 = new S3();

// Get table prefix based on NODE_ENV
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";


// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Helper function to upload file to S3
async function uploadBrandFile(
  file: Express.Multer.File,
  userId: string,
  fileType: string
): Promise<{ url: string; key: string }> {
  console.log(
    `[BRAND DEBUG] Uploading file: ${file.originalname} for user: ${userId}`
  );

  const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const key = `users/${userId}/brand/${fileType}/${Date.now()}-${randomToken}-${
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

  const url = `https://${
    process.env.AWS_S3_BUCKET || "agentweb-user-files"
  }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;

  return { url, key };
}

// Get user's brand guidelines
router.get("/guidelines", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    const result = await dynamodb
      .query({
        TableName: `${TABLE_PREFIX}AW-Users`,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      })
      .promise();

    const users = result.Items || [];

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = users[0];
    const brandGuidelines = user.brandGuidelines;

    if (!brandGuidelines) {
      return res.json({
        exists: false,
        message: "No brand guidelines found",
      });
    }

    res.json({
      exists: true,
      brandData: brandGuidelines.brandData || {},
      attachments: brandGuidelines.attachments || [],
      createdAt: brandGuidelines.createdAt,
      updatedAt: brandGuidelines.updatedAt,
    });
  } catch (error) {
    console.error("[BRAND DEBUG] Error fetching brand guidelines:", error);
    res.status(500).json({ error: "Failed to fetch brand guidelines" });
  }
});

// Create or update brand guidelines
router.post(
  "/guidelines",
  authenticateToken,
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "secondaryLogo", maxCount: 1 },
    { name: "brandGuide", maxCount: 1 },
    { name: "additionalAssets", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      const userId = (req as AuthenticatedRequest).user?.userId;

      if (!userId) {
        return res.status(401).json({ error: "User ID not provided" });
      }

      const {
        primaryColor,
        primaryColorEnd,
        secondaryColor,
        fontFamily,
        toneOfVoice,
        keyMessages,
        brandName,
        tagline,
        brandValues,
        targetAudience,
        brandPersonality,
        founders,
        isGradient,
      } = req.body;

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };

      // Upload files to S3
      const attachments = [];

      if (files.logo && files.logo[0]) {
        const { url, key } = await uploadBrandFile(
          files.logo[0],
          userId,
          "logo"
        );
        attachments.push({
          type: "logo",
          url,
          key,
          filename: files.logo[0].originalname,
        });
      }

      if (files.secondaryLogo && files.secondaryLogo[0]) {
        const { url, key } = await uploadBrandFile(
          files.secondaryLogo[0],
          userId,
          "logo"
        );
        attachments.push({
          type: "secondaryLogo",
          url,
          key,
          filename: files.secondaryLogo[0].originalname,
        });
      }

      if (files.brandGuide && files.brandGuide[0]) {
        const { url, key } = await uploadBrandFile(
          files.brandGuide[0],
          userId,
          "documents"
        );
        attachments.push({
          type: "brandGuide",
          url,
          key,
          filename: files.brandGuide[0].originalname,
        });
      }

      if (files.additionalAssets) {
        for (const file of files.additionalAssets) {
          const { url, key } = await uploadBrandFile(file, userId, "assets");
          attachments.push({
            type: "asset",
            url,
            key,
            filename: file.originalname,
          });
        }
      }

      console.log(
        `[BRAND DEBUG] Uploaded ${attachments.length} new attachments`
      );

      // Get current user to access existing brand guidelines
      console.log(
        `[BRAND DEBUG] Fetching existing user data from: ${TABLE_PREFIX}AW-Users`
      );

      const userResult = await dynamodb
        .query({
          TableName: `${TABLE_PREFIX}AW-Users`,
          IndexName: "UserIdIndex",
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: {
            ":userId": userId,
          },
        })
        .promise();

      if (!userResult.Items || userResult.Items.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = userResult.Items[0];
      const existingBrandGuidelines = user.brandGuidelines;

      // Parse keyMessages if it's a string
      let parsedKeyMessages = [];
      if (keyMessages) {
        try {
          parsedKeyMessages =
            typeof keyMessages === "string"
              ? JSON.parse(keyMessages)
              : keyMessages;
        } catch (e) {
          parsedKeyMessages =
            typeof keyMessages === "string" ? [keyMessages] : keyMessages;
        }
      }

      // Parse brandValues if it's a string
      let parsedBrandValues = [];
      if (brandValues) {
        try {
          parsedBrandValues =
            typeof brandValues === "string"
              ? JSON.parse(brandValues)
              : brandValues;
        } catch (e) {
          parsedBrandValues =
            typeof brandValues === "string" ? [brandValues] : brandValues;
        }
      }

      // Parse founders if it's a string; preserve existing if not provided
      let parsedFounders = existingBrandGuidelines?.brandData?.founders || [];
      if (typeof founders !== 'undefined') {
        try {
          parsedFounders =
            typeof founders === 'string' ? JSON.parse(founders) : founders;
        } catch (e) {
          // If bad payload, keep existing founders
          parsedFounders = existingBrandGuidelines?.brandData?.founders || [];
        }
      }

      // Parse isGradient if it's a string
      let parsedIsGradient = existingBrandGuidelines?.brandData?.isGradient ?? false;
      if (isGradient !== undefined) {
        parsedIsGradient = typeof isGradient === 'string' ? isGradient === 'true' : Boolean(isGradient);
      }

      const brandGuidelinesData = {
        brandData: {
          // Only update fields that are provided, preserve existing data for missing fields
          brandName: brandName !== undefined ? brandName : (existingBrandGuidelines?.brandData?.brandName || ""),
          tagline: tagline !== undefined ? tagline : (existingBrandGuidelines?.brandData?.tagline || ""),
          primaryColor: primaryColor !== undefined ? primaryColor : (existingBrandGuidelines?.brandData?.primaryColor || ""),
          primaryColorEnd: primaryColorEnd !== undefined ? primaryColorEnd : (existingBrandGuidelines?.brandData?.primaryColorEnd || ""),
          secondaryColor: secondaryColor !== undefined ? secondaryColor : (existingBrandGuidelines?.brandData?.secondaryColor || ""),
          fontFamily: fontFamily !== undefined ? fontFamily : (existingBrandGuidelines?.brandData?.fontFamily || ""),
          toneOfVoice: toneOfVoice !== undefined ? toneOfVoice : (existingBrandGuidelines?.brandData?.toneOfVoice || ""),
          keyMessages: parsedKeyMessages,
          brandValues: parsedBrandValues,
          targetAudience: targetAudience !== undefined ? targetAudience : (existingBrandGuidelines?.brandData?.targetAudience || ""),
          brandPersonality: brandPersonality !== undefined ? brandPersonality : (existingBrandGuidelines?.brandData?.brandPersonality || ""),
          isGradient: parsedIsGradient,
          founders: parsedFounders,
        },
        attachments: [
          ...(existingBrandGuidelines?.attachments || []),
          ...attachments,
        ],
        createdAt:
          existingBrandGuidelines?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      console.log(
        `[BRAND DEBUG] Prepared brand guidelines data:`,
        JSON.stringify(brandGuidelinesData, null, 2)
      );
      console.log(
        `[BRAND DEBUG] About to update user with email: ${user.email}`
      );

      // Update user record with brand guidelines
      const updateParams = {
        TableName: `${TABLE_PREFIX}AW-Users`,
        Key: { email: user.email }, // Use email as primary key
        UpdateExpression:
          "SET brandGuidelines = :brandGuidelines, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":brandGuidelines": brandGuidelinesData,
          ":updatedAt": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      };

      console.log(
        `[BRAND DEBUG] Update parameters:`,
        JSON.stringify(updateParams, null, 2)
      );

      const updateResult = await dynamodb.update(updateParams).promise();

      console.log(
        `[BRAND DEBUG] Update successful! Updated attributes:`,
        updateResult.Attributes?.brandGuidelines
          ? "brandGuidelines field exists"
          : "brandGuidelines field missing"
      );

      res.status(201).json({
        message: "Brand guidelines saved successfully",
        attachments: attachments.length,
        debug: {
          userEmail: user.email,
          updateSuccess: true,
          brandGuidelinesExists: !!updateResult.Attributes?.brandGuidelines,
        },
      });
    } catch (error) {
      console.error("[BRAND DEBUG] Error saving brand guidelines:", error);
      res.status(500).json({
        error: "Failed to save brand guidelines",
        debug: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

// Delete a brand asset
router.delete("/guidelines/asset/:key", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { key } = req.params;

    console.log(
      `[BRAND DEBUG] DELETE asset request for user: ${userId}, key: ${key}`
    );

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // Get current user and brand guidelines
    const result = await dynamodb
      .query({
        TableName: `${TABLE_PREFIX}AW-Users`,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      })
      .promise();

    if (!result.Items || result.Items.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.Items[0];
    const brandGuidelines = user.brandGuidelines;

    if (!brandGuidelines) {
      return res.status(404).json({ error: "Brand guidelines not found" });
    }

    // Remove the asset from attachments
    const updatedAttachments = (brandGuidelines.attachments || []).filter(
      (attachment: any) => attachment.key !== key
    );

    console.log(
      `[BRAND DEBUG] Removing asset, before: ${
        brandGuidelines.attachments?.length || 0
      }, after: ${updatedAttachments.length}`
    );

    // Delete from S3
    try {
      await s3
        .deleteObject({
          Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
          Key: decodeURIComponent(key),
        })
        .promise();
    } catch (s3Error) {
      console.warn("Failed to delete from S3:", s3Error);
      // Continue with database update even if S3 deletion fails
    }

    // Update the user's brand guidelines
    const updatedBrandGuidelines = {
      ...brandGuidelines,
      attachments: updatedAttachments,
      updatedAt: new Date().toISOString(),
    };

    await dynamodb
      .update({
        TableName: `${TABLE_PREFIX}AW-Users`,
        Key: { email: user.email },
        UpdateExpression:
          "SET brandGuidelines = :brandGuidelines, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":brandGuidelines": updatedBrandGuidelines,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    console.log(
      `[BRAND DEBUG] Successfully updated user brand guidelines after asset deletion`
    );

    res.json({ message: "Asset deleted successfully" });
  } catch (error) {
    console.error("[BRAND DEBUG] Error deleting brand asset:", error);
    res.status(500).json({ error: "Failed to delete brand asset" });
  }
});

export default router;
