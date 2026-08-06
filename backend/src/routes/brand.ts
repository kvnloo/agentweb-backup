import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { DynamoDB } from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import { userDb, orgDb } from "../services/db";
import multer from "multer";
import { S3 } from "aws-sdk";
import crypto from "crypto";
import { MAX_FILE_SIZE } from "../config";
import {
  buildReadyPatch,
  logCompletionMetric,
} from "../services/brandBuildStatusService";
import { canEditItem } from "../services/orgShareService";
import { resolveOrgProfileField } from "../services/orgProfileResolver";

const router = Router();
const dynamodb = new DynamoDB.DocumentClient();
const s3 = new S3();

// Get table prefix based on NODE_ENV
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";


// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE, // 100MB limit to match global upload cap
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
    const email = (req as AuthenticatedRequest).user?.email;

    if (!email) {
      return res.status(401).json({ error: "User email not provided" });
    }

    // Use primary key (email) with ConsistentRead to avoid GSI eventual consistency issues
    const result = await dynamodb
      .get({
        TableName: `${TABLE_PREFIX}AW-Users`,
        Key: { email },
        ConsistentRead: true,
      })
      .promise();

    const user = result.Item;

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // If user is in an org, read brand guidelines from the org — falling back to
    // the org owner's user record when the org was created without copying the
    // owner's profile over, so the pillar does not silently go blank (ENG-927).
    let brandGuidelines = user.brandGuidelines;
    let isOrgLevel = false;
    if (user.orgId) {
      const org = await orgDb.getOrgById(user.orgId);
      if (org) {
        brandGuidelines = await resolveOrgProfileField(user, org, "brandGuidelines");
        isOrgLevel = true;
      }
    }

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
      isOrgLevel,
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
        domain,
        brandValues,
        targetAudience,
        brandPersonality,
        founders,
        isGradient,
        brandGuideUrl,
      } = req.body;

      // multer only populates req.files on multipart requests; a JSON save
      // (e.g. brand edits or the onboarding manual-brand fallback) has none, so
      // default to {} rather than dereferencing undefined below.
      const files = (req.files ?? {}) as {
        [fieldname: string]: Express.Multer.File[];
      };

      // Reject SVG files for logo uploads - SVG can contain scripts and is not suitable for logo storage
      const SVG_MIME_TYPES = ["image/svg+xml"];
      const logoFields = ["logo", "secondaryLogo"] as const;
      for (const field of logoFields) {
        const file = files[field]?.[0];
        if (file && (SVG_MIME_TYPES.includes(file.mimetype) || file.originalname.toLowerCase().endsWith(".svg"))) {
          return res.status(400).json({
            error: `SVG files are not supported for ${field === "logo" ? "primary" : "secondary"} logo uploads. Please convert your SVG to PNG or another raster format before uploading.`,
          });
        }
      }

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

      // Handle brand guide URL (alternative to file upload)
      if (brandGuideUrl && typeof brandGuideUrl === "string" && brandGuideUrl.trim()) {
        attachments.push({
          type: "brandGuide",
          url: brandGuideUrl.trim(),
          key: `url-brandguide-${Date.now()}`,
          filename: "url",
        });
      }

      console.log(
        `[BRAND DEBUG] Uploaded ${attachments.length} new attachments`
      );

      // Get current user to access existing brand guidelines
      console.log(
        `[BRAND DEBUG] Fetching existing user data from: ${TABLE_PREFIX}AW-Users`
      );

      const userEmail = (req as AuthenticatedRequest).user?.email;
      if (!userEmail) {
        return res.status(401).json({ error: "User email not provided" });
      }

      // Use primary key (email) with ConsistentRead to avoid GSI eventual consistency issues
      // that could cause recently uploaded attachments (e.g. logos) to be lost when saving.
      const userResult = await dynamodb
        .get({
          TableName: `${TABLE_PREFIX}AW-Users`,
          Key: { email: userEmail },
          ConsistentRead: true,
        })
        .promise();

      if (!userResult.Item) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = userResult.Item;

      // For org users, read existing brand guidelines from the org record (not the user record).
      // Brand guidelines for org members are stored at the org level, so reading from the user
      // record would cause existing org-level attachments (like logos) to be lost when saving.
      let existingBrandGuidelines = user.brandGuidelines;
      let postOrg: Awaited<ReturnType<typeof orgDb.getOrgById>> | undefined;
      if (user.orgId) {
        postOrg = await orgDb.getOrgById(user.orgId);
        if (postOrg) {
          existingBrandGuidelines = await resolveOrgProfileField(
            user,
            postOrg,
            "brandGuidelines"
          );
        }
      }

      // Parse keyMessages if it's a string; preserve existing if not provided
      let parsedKeyMessages = existingBrandGuidelines?.brandData?.keyMessages || [];
      if (keyMessages !== undefined) {
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

      // Parse brandValues if it's a string; preserve existing if not provided
      let parsedBrandValues = existingBrandGuidelines?.brandData?.brandValues || [];
      if (brandValues !== undefined) {
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
          domain: domain !== undefined ? domain : (existingBrandGuidelines?.brandData?.domain || ""),
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

      // If user is in an org, save to org (admin or listed editor only); otherwise save to user
      if (user.orgId) {
        const allowed = canEditItem(
          { userId: postOrg?.ownerUserId } as any,
          { userId: user.userId, orgId: user.orgId, orgRole: user.orgRole as "owner" | "member" | undefined },
          postOrg ?? null,
          user.orgId,
          "brandGuidelines",
        );
        if (!allowed) {
          return res.status(403).json({ message: "Not authorized to edit brand guidelines" });
        }
        await orgDb.updateOrg(user.orgId, { brandGuidelines: brandGuidelinesData });
        console.log(`[BRAND DEBUG] Updated org ${user.orgId} brand guidelines`);
        // Onboarding v2 Phase 1: flip brand-build status to ready if we were
        // building. Uses the user record (not the org) because the status
        // pill is per-user in the onboarding flow. Best-effort; never blocks
        // the save response on a metrics write.
        try {
          // An explicit guidelines save completes the build even from a failed
          // state — a manually-supplied brand IS ready (unblocks the
          // unscrapable-site case where the user is otherwise gated on
          // buildingBrand).
          const readyPatch = buildReadyPatch(user as any, new Date(), {
            includeFailed: true,
          });
          if (readyPatch) {
            await userDb.updateUser(user.userId, readyPatch);
            logCompletionMetric(user.userId, "ready", readyPatch.brandBuildDurationMs ?? 0);
          }
        } catch (e) {
          console.warn("[brandBuild] ready-patch failed (org path)", e);
        }
        return res.status(201).json({
          message: "Brand guidelines saved successfully (org-level)",
          attachments: attachments.length,
        });
      }

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

      // Onboarding v2 Phase 1: flip brand-build status to ready if we were
      // building. Best-effort; metrics log emitted on success so the log
      // scraper can compute p50/p99.
      try {
        // An explicit guidelines save completes the build even from a failed
        // state — a manually-supplied brand IS ready (unblocks the
        // unscrapable-site case where the user is otherwise gated on
        // buildingBrand).
        const readyPatch = buildReadyPatch(user as any, new Date(), {
          includeFailed: true,
        });
        if (readyPatch) {
          await userDb.updateUser(user.userId, readyPatch);
          logCompletionMetric(user.userId, "ready", readyPatch.brandBuildDurationMs ?? 0);
        }
      } catch (e) {
        console.warn("[brandBuild] ready-patch failed (user path)", e);
      }

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
    // URL fallback for legacy assets that have no key field
    const urlFallback = req.query.url as string | undefined;

    console.log(
      `[BRAND DEBUG] DELETE asset request for user: ${userId}, key: ${key}, urlFallback: ${urlFallback}`
    );

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // Get current user via primary key with ConsistentRead to avoid GSI eventual consistency
    // issues that could cause recently uploaded attachments to be lost.
    const deleteUserEmail = (req as AuthenticatedRequest).user?.email;
    if (!deleteUserEmail) {
      return res.status(401).json({ error: "User email not provided" });
    }
    const deleteUserResult = await dynamodb
      .get({
        TableName: `${TABLE_PREFIX}AW-Users`,
        Key: { email: deleteUserEmail },
        ConsistentRead: true,
      })
      .promise();
    const user = deleteUserResult.Item;
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Determine source: org-level or user-level
    let brandGuidelines: any;
    let isOrgLevel = false;
    if (user.orgId) {
      const org = await orgDb.getOrgById(user.orgId);
      const allowed = canEditItem(
        { userId: org?.ownerUserId } as any,
        { userId: user.userId, orgId: user.orgId, orgRole: user.orgRole as "owner" | "member" | undefined },
        org ?? null,
        user.orgId,
        "brandGuidelines",
      );
      if (!allowed) {
        return res.status(403).json({ message: "Not authorized to edit brand guidelines" });
      }
      if (org) {
        // Same owner-record fallback the GET uses, so an asset the settings page
        // shows for an un-copied org can actually be deleted (ENG-927). The write
        // still targets the org record, which is authoritative from here on.
        brandGuidelines = await resolveOrgProfileField(user, org, "brandGuidelines");
        isOrgLevel = true;
      }
    } else {
      brandGuidelines = user.brandGuidelines;
    }

    if (!brandGuidelines) {
      return res.status(404).json({ error: "Brand guidelines not found" });
    }

    // Resolve the request against the caller's OWN attachments before deleting
    // anything. `key` and `?url=` come straight from the request, so using them
    // as the S3 key directly let any authenticated user with brand guidelines
    // delete any object in the bucket.
    // For keyless legacy assets, match by URL instead of key.
    const isValidKey = key && key !== "undefined";
    const attachments: any[] = brandGuidelines.attachments || [];
    const target = attachments.find((attachment: any) =>
      isValidKey
        ? attachment.key === key
        : !!urlFallback && attachment.url === urlFallback
    );
    if (!target) {
      return res.status(404).json({ error: "Asset not found" });
    }

    // Determine S3 key for deletion from the matched attachment. Legacy assets
    // have no key field, so fall back to extracting it from the asset URL.
    let s3Key: string | undefined =
      typeof target.key === "string" && target.key !== "undefined" ? target.key : undefined;
    if (!s3Key && typeof target.url === "string") {
      const bucketPrefix = `https://${process.env.AWS_S3_BUCKET || "agentweb-user-files"}.s3.us-west-2.amazonaws.com/`;
      if (target.url.startsWith(bucketPrefix)) {
        s3Key = target.url.slice(bucketPrefix.length);
      }
    }

    // A match is guaranteed here, so this drops the target (and any duplicate
    // entries pointing at the same object, as before).
    const updatedAttachments = attachments.filter((attachment: any) =>
      isValidKey ? attachment.key !== key : attachment.url !== urlFallback
    );

    console.log(
      `[BRAND DEBUG] Removing asset, before: ${
        brandGuidelines.attachments?.length || 0
      }, after: ${updatedAttachments.length}`
    );

    // Delete from S3
    if (s3Key) {
      try {
        await s3
          .deleteObject({
            Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
            Key: s3Key,
          })
          .promise();
      } catch (s3Error) {
        console.warn("Failed to delete from S3:", s3Error);
        // Continue with database update even if S3 deletion fails
      }
    }

    // Update brand guidelines
    const updatedBrandGuidelines = {
      ...brandGuidelines,
      attachments: updatedAttachments,
      updatedAt: new Date().toISOString(),
    };

    if (isOrgLevel) {
      await orgDb.updateOrg(user.orgId!, { brandGuidelines: updatedBrandGuidelines });
      console.log(`[BRAND DEBUG] Successfully updated org brand guidelines after asset deletion`);
    } else {
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
      console.log(`[BRAND DEBUG] Successfully updated user brand guidelines after asset deletion`);
    }

    res.json({ message: "Asset deleted successfully" });
  } catch (error) {
    console.error("[BRAND DEBUG] Error deleting brand asset:", error);
    res.status(500).json({ error: "Failed to delete brand asset" });
  }
});

export default router;
