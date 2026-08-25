"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileLock2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/**
 * Consent publishing is irreversible: an enrollment must always resolve to
 * the exact text accepted by that participant (FR-04). The acknowledgement is
 * therefore part of the action, not a toast shown after it is too late.
 */
export function ConsentPublishDialog({
  nextVersionNumber,
  disabled,
  publishing,
  onPublish,
}: {
  nextVersionNumber: number;
  disabled: boolean;
  publishing: boolean;
  /** Returns true only when the server accepted the publish. */
  onPublish: () => Promise<boolean>;
}) {
  const t = useTranslations("consent");
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) setAcknowledged(false);
  }

  async function publish() {
    if (!acknowledged || publishing) return;
    await onPublish();
    // On failure the page-level banner contains the actionable message. Close
    // the modal so that message is not hidden beneath the dialog overlay.
    changeOpen(false);
  }

  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogTrigger asChild>
        <Button type="button" disabled={disabled || publishing}>
          <FileLock2 />
          {publishing ? t("publishing") : t("publish")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-danger-muted text-danger-muted-foreground">
            <FileLock2 />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("publishHeading", { version: nextVersionNumber })}</AlertDialogTitle>
          <AlertDialogDescription>{t("publishImmutableWarning")}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-start gap-3 rounded-lg border p-3">
          <Checkbox
            id="consent-publish-acknowledgement"
            checked={acknowledged}
            disabled={publishing}
            onCheckedChange={(checked) => setAcknowledged(checked === true)}
          />
          <Label htmlFor="consent-publish-acknowledgement" className="cursor-pointer leading-snug">
            {t("publishAcknowledge")}
          </Label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={publishing}>{t("cancel")}</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={!acknowledged || publishing}
            onClick={() => void publish()}
          >
            {publishing ? t("publishing") : t("publishConfirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
