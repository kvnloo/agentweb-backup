import React from "react";
import { Box, Chip, Tooltip } from "@mui/material";
import { productPills, signupTooltip, type ProductAttribution } from "../../utils/productBadges";

/** ENG-2906: small product pills beside a user's email — Zoma (purple), Emma MCP (subtle). */
export default function ProductPills({ user }: { user: ProductAttribution }) {
  const pills = productPills(user);
  if (!pills.length) return null;
  const tooltip = signupTooltip(user);
  return (
    <Box component="span" sx={{ display: "inline-flex", gap: 0.5, ml: 0.75, verticalAlign: "middle" }}>
      {pills.map((pill) => (
        <Tooltip key={pill.product} title={tooltip}>
          <Chip
            component="span"
            label={pill.label}
            size="small"
            aria-label={tooltip}
            variant={pill.product === "zoma" ? "filled" : "outlined"}
            sx={{
              height: 18,
              fontSize: "0.6875rem",
              fontWeight: 600,
              "& .MuiChip-label": { px: 0.75 },
              ...(pill.product === "zoma"
                ? { bgcolor: "#7c3aed", color: "#fff" }
                : { color: "text.secondary", borderColor: "divider" }),
            }}
          />
        </Tooltip>
      ))}
    </Box>
  );
}
