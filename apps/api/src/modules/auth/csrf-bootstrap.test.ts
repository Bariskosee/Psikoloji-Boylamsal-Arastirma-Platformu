import { describe, expect, it } from "vitest";
import { CSRF_COOKIE_NAME } from "@lpr/contracts";
import { ApiException } from "../../common/api-error.js";
import { hashToken } from "../../common/crypto.js";
import type { AuthenticatedRequest } from "./auth.types.js";
import { readResearcherCsrfToken } from "./csrf-bootstrap.js";

const RESEARCHER_ORIGIN = "https://research.example.org";
const PARTICIPANT_ORIGIN = "https://app.example.org";
const TOKEN = "the-session-paired-csrf-token";

function requestFrom(origin: string | undefined, cookie = TOKEN): AuthenticatedRequest {
  return {
    headers: origin === undefined ? {} : { origin },
    cookies: { [CSRF_COOKIE_NAME]: cookie },
  } as unknown as AuthenticatedRequest;
}

function expectCsrfFailure(run: () => unknown): void {
  try {
    run();
    throw new Error("Expected CSRF failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("CSRF_FAILED");
    expect(error).not.toHaveProperty("response.csrfToken");
  }
}

describe("researcher CSRF bootstrap", () => {
  it("returns the cookie when exact origin and session hash both match", () => {
    expect(
      readResearcherCsrfToken(requestFrom(RESEARCHER_ORIGIN), RESEARCHER_ORIGIN, hashToken(TOKEN)),
    ).toBe(TOKEN);
  });

  it("rejects the participant sibling origin", () => {
    expectCsrfFailure(() =>
      readResearcherCsrfToken(requestFrom(PARTICIPANT_ORIGIN), RESEARCHER_ORIGIN, hashToken(TOKEN)),
    );
  });

  it("rejects requests without an exact Origin header", () => {
    expectCsrfFailure(() =>
      readResearcherCsrfToken(requestFrom(undefined), RESEARCHER_ORIGIN, hashToken(TOKEN)),
    );
  });

  it("rejects a cookie that is not paired with the authenticated session", () => {
    expectCsrfFailure(() =>
      readResearcherCsrfToken(
        requestFrom(RESEARCHER_ORIGIN, "different-token"),
        RESEARCHER_ORIGIN,
        hashToken(TOKEN),
      ),
    );
  });
});
