import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConsentPublishDialog } from "./ConsentPublishDialog";
import { withIntl } from "@/components/questionnaire/test-intl";

afterEach(cleanup);

function renderDialog(overrides: Partial<Parameters<typeof ConsentPublishDialog>[0]> = {}) {
  const onPublish = vi.fn().mockResolvedValue(true);
  render(
    withIntl(
      <ConsentPublishDialog
        nextVersionNumber={2}
        disabled={false}
        publishing={false}
        onPublish={onPublish}
        {...overrides}
      />,
    ),
  );
  return onPublish;
}

describe("ConsentPublishDialog", () => {
  it("requires an explicit immutability acknowledgement", async () => {
    const onPublish = renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Publish consent" }));
    });

    expect(screen.getByText(/can never be edited, corrected, or deleted/i)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Publish permanently" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox"));
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("does not open while the draft has unsaved or empty content", () => {
    renderDialog({ disabled: true });
    const trigger = screen.getByRole("button", { name: "Publish consent" });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes after a rejected publish so the page error remains visible", async () => {
    const onPublish = vi.fn().mockResolvedValue(false);
    renderDialog({ onPublish });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Publish consent" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Publish permanently" }));
    });

    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
