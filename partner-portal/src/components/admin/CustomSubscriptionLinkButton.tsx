import React, { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
  Link,
} from "@mui/material";
import {
  buildCustomLinkRequest,
  CUSTOM_LINK_FREQUENCIES,
  CUSTOM_LINK_LABEL_MAX,
  type CustomLinkRequestBody,
} from "./customSubscriptionLinkForm";

export interface CustomSubscriptionLinkButtonProps {
  orgId?: string | null;
  /** Viewer is a partner-portal admin. */
  viewerIsAdmin: boolean;
  /** Feature flag `customSubscriptionLinks` (default off). */
  enabled: boolean;
  /** Posts to POST /api/admin/custom-subscription-links; returns the checkout url. */
  submit: (body: CustomLinkRequestBody) => Promise<{ url: string }>;
}

/** ENG-2488: admin-only "Create custom subscription link" button + form. */
const CustomSubscriptionLinkButton: React.FC<CustomSubscriptionLinkButtonProps> = ({ orgId, viewerIsAdmin, enabled, submit }) => {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [amountUsd, setAmountUsd] = useState("");
  const [frequency, setFrequency] = useState("month");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!enabled || !viewerIsAdmin || !orgId) return null;

  const close = () => {
    setOpen(false);
    setErrors({});
    setSubmitError(null);
    setUrl(null);
  };

  const onSubmit = async () => {
    const result = buildCustomLinkRequest({ orgId, label, amountUsd, frequency });
    if (result.ok === false) {
      setErrors(result.errors as Record<string, string>);
      return;
    }
    setErrors({});
    setSubmitError(null);
    setBusy(true);
    try {
      const res = await submit(result.body);
      setUrl(res.url);
    } catch (err: any) {
      setSubmitError(err?.response?.data?.message || err?.message || "Failed to create link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="small" variant="outlined" onClick={() => setOpen(true)}>
        Create custom subscription link
      </Button>
      <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
        <DialogTitle>Create custom subscription link</DialogTitle>
        <DialogContent>
          <TextField
            label="Name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            inputProps={{ maxLength: CUSTOM_LINK_LABEL_MAX + 1 }}
            error={!!errors.label}
            helperText={errors.label}
            fullWidth
            margin="dense"
          />
          <TextField
            label="Price (USD)"
            value={amountUsd}
            onChange={(e) => setAmountUsd(e.target.value)}
            error={!!errors.amountUsd}
            helperText={errors.amountUsd}
            fullWidth
            margin="dense"
          />
          <TextField
            select
            label="Frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            error={!!errors.frequency}
            helperText={errors.frequency}
            fullWidth
            margin="dense"
          >
            {CUSTOM_LINK_FREQUENCIES.map((f) => (
              <MenuItem key={f.value} value={f.value}>
                {f.label}
              </MenuItem>
            ))}
          </TextField>
          {submitError && <Typography color="error" variant="body2">{submitError}</Typography>}
          {url && (
            <Typography variant="body2" sx={{ wordBreak: "break-all", mt: 1 }}>
              Link: <Link href={url} target="_blank" rel="noopener noreferrer">{url}</Link>
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Close</Button>
          <Button onClick={onSubmit} disabled={busy} variant="contained">
            Create link
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default CustomSubscriptionLinkButton;
