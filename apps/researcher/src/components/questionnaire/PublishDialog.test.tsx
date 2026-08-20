import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublishDialog } from "./PublishDialog";
import { withIntl } from "./test-intl";

afterEach(cleanup);

/**
 * PLAN.md Phase 3 requires "an explicit 'this becomes immutable' confirmation
 * at publish".
 *
 * Publishing is the only irreversible action in the builder — the database
 * refuses to update or delete a published version — so the guard against an
 * accidental click is not a nicety. These tests exist so that a future
 * simplification of the dialog cannot quietly remove it.
 */
function renderDialog(overrides: Partial<Parameters<typeof PublishDialog>[0]> = {}) {
  const onPublish = vi.fn();
  const onCancel = vi.fn();
  render(
    withIntl(
      <PublishDialog
        questionCount={3}
        nextVersionNumber={1}
        publishing={false}
        onPublish={onPublish}
        onCancel={onCancel}
        {...overrides}
      />,
    ),
  );
  return { onPublish, onCancel };
}

const publishButton = () => screen.getByRole("button", { name: /Publish permanently/i });
const acknowledgement = () => screen.getByRole("checkbox");

describe("PublishDialog", () => {
  it("states in words that the version becomes permanent", () => {
    renderDialog();
    expect(screen.getByText(/can never be edited, corrected, or deleted/i)).toBeTruthy();
  });

  it("disables publishing until the acknowledgement is ticked", () => {
    const { onPublish } = renderDialog();

    expect((publishButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(publishButton());
    expect(onPublish).not.toHaveBeenCalled();

    fireEvent.click(acknowledgement());
    expect((publishButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("publishes only after the acknowledgement", () => {
    const { onPublish } = renderDialog();
    fireEvent.click(acknowledgement());
    fireEvent.click(publishButton());
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("re-arms the guard when the acknowledgement is un-ticked", () => {
    const { onPublish } = renderDialog();
    fireEvent.click(acknowledgement());
    fireEvent.click(acknowledgement());

    expect((publishButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(publishButton());
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("cancels without publishing, acknowledged or not", () => {
    const { onPublish, onCancel } = renderDialog();
    fireEvent.click(acknowledgement());
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("blocks a second click while a publish is already in flight", () => {
    const { onPublish } = renderDialog({ publishing: true });
    fireEvent.click(acknowledgement());
    fireEvent.click(screen.getByRole("button", { name: /Publishing/i }));
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("names the version about to be created and how many questions it will hold", () => {
    renderDialog({ nextVersionNumber: 4, questionCount: 12 });
    expect(screen.getByRole("heading", { name: /Publish version 4/i })).toBeTruthy();
    expect(screen.getByText(/12 questions will be copied/i)).toBeTruthy();
  });
});
