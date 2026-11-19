import { describe, expect, it } from "vitest";
import { AnsError } from "../src/errors.js";
import { formatAnsName, parseAgentHost, parseAnsName } from "../src/name.js";

describe("ANSName", () => {
  it("parses the ANS-2 form and canonicalizes the host", () => {
    const parsed = parseAnsName("ans://v1.4.2.Travel.Example.COM.");
    expect(parsed).toMatchObject({
      ansName: "ans://v1.4.2.travel.example.com",
      version: "1.4.2",
      versionLabel: "v1.4.2",
      agentHost: "travel.example.com",
    });
  });

  it("accepts a host that ends in .ans as an ordinary FQDN", () => {
    const parsed = parseAnsName("ans://v1.0.0.agent.example.ans");
    expect(parsed.agentHost).toBe("agent.example.ans");
    expect(parsed.ansName).toBe("ans://v1.0.0.agent.example.ans");
  });

  it("round-trips formatAnsName", () => {
    expect(formatAnsName("1.2.3", "support.acme.example")).toBe(
      "ans://v1.2.3.support.acme.example",
    );
  });

  it.each([
    ["travel.example.com", "bare host"],
    ["ANS://v1.0.0.travel.example.com", "uppercase scheme"],
    ["ans://v1.0.0-beta.travel.example.com", "prerelease"],
    ["ans://v01.0.0.travel.example.com", "leading zero"],
    ["ans://v1.0.travel.example.com", "missing patch"],
    ["ans://v1.0.0.localhost", "single label"],
    ["ans://v1.0.0.exa_mple.com", "underscore"],
    ["ans://v1.0.0.-bad.example", "leading hyphen"],
    ["ans://v1.0.0.旅行.example", "unicode label"],
    ["", "empty"],
  ])("rejects %s (%s)", (input) => {
    expect(() => parseAnsName(input)).toThrow(AnsError);
    try {
      parseAnsName(input);
    } catch (error) {
      expect(error).toBeInstanceOf(AnsError);
      expect((error as AnsError).code).toBe("INVALID_NAME");
      expect((error as AnsError).hint).toBeTruthy();
    }
  });

  it("rejects a host that cannot carry an _ans-badge name", () => {
    const label = "a".repeat(63);
    const host = `${label}.${label}.${label}.${"b".repeat(51)}`;
    expect(host.length).toBeLessThanOrEqual(253);
    expect(() => parseAgentHost(host)).not.toThrow();
    expect(() => parseAnsName(`ans://v1.0.0.${host}`)).toThrow(/_ans-badge/);
  });
});
