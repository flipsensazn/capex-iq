import assert from "node:assert/strict";
import test from "node:test";

import { countPendingMembers } from "../src/lib/members.js";

test("countPendingMembers counts only well-formed members without an enabled feature", () => {
  assert.equal(countPendingMembers([]), 0);
  assert.equal(countPendingMembers([{ email: "pending@example.com", features: {} }]), 1);
  assert.equal(countPendingMembers([{
    email: "disabled@example.com",
    features: { research: false, radar: false },
  }]), 1);

  assert.equal(countPendingMembers([{
    email: "approved@example.com",
    features: { research: false, radar: true },
  }]), 0);

  assert.equal(countPendingMembers([
    { email: "malformed@example.com", malformed: true, features: {} },
    null,
    "not-a-member",
  ]), 0);

  assert.equal(countPendingMembers([{
    email: "quota-only@example.com",
    features: {},
    researchQuota: 50,
  }]), 1);

  assert.equal(countPendingMembers(null), 0);
  assert.equal(countPendingMembers({}), 0);
  assert.equal(countPendingMembers("members"), 0);
});
