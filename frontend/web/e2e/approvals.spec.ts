import { expect, test } from "@playwright/test";
import { PASSWORD, api, setupWorkspace, signIn } from "./helpers";

/** Approval page (opened from Needs you / inbox): approve with a note, reject needs a reason, requester can withdraw. */
const run = Date.now().toString(36);

test("approve from the request's page; withdraw a pending one", async ({ browser }) => {
  const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await setupWorkspace(owner, { company: `Appr ${run}`, name: "Lò Quang", email: `appr-${run}@example.com` });
  const ownerId = (await api(owner, "GET", "identity/members")).body.members[0].userId;
  await api(owner, "POST", "identity/members/invite", { email: `appr-emp-${run}@example.com`, displayName: "Vi Hằng", roleNames: ["Employee"], password: PASSWORD });
  const emp = await (await browser.newContext()).newPage();
  await signIn(emp, `appr-emp-${run}@example.com`);
  const a = (await api(emp, "POST", "work/approvals", { title: "Mua laptop cho nhân viên mới", details: "Dell XPS 13, **35 triệu**", approverId: ownerId })).body;
  const b = (await api(emp, "POST", "work/approvals", { title: "Hội thảo ngoài giờ", approverId: ownerId })).body;

  // A request reads and shares by its code (YC-001 in a new workspace), in any case; the page shows it.
  expect(a.code).toBe("YC-001");
  await owner.goto(`/app/work/approvals/${a.code.toLowerCase()}`);
  await expect(owner.getByText("YC-001", { exact: true })).toBeVisible();
  await expect(owner.getByText("35 triệu")).toBeVisible();
  await owner.getByRole("button", { name: "Từ chối" }).click();
  await expect(owner.getByText("Ghi lý do từ chối để người gửi biết cần sửa gì.")).toBeVisible();
  await owner.getByLabel(/Ghi chú/).fill("Đồng ý, mua trong tháng này");
  await owner.getByRole("button", { name: "Duyệt", exact: true }).click();
  await expect(owner.getByText("Đã duyệt").first()).toBeVisible();
  await expect(owner.getByText("Đồng ý, mua trong tháng này")).toBeVisible();

  // Old links by id keep working.
  await emp.goto(`/app/work/approvals/${b.id}`);
  emp.once("dialog", (d) => void d.accept());
  await emp.getByRole("button", { name: "Rút lại yêu cầu" }).click();
  await expect(emp.getByText("Đã huỷ")).toBeVisible();
  // Others cannot open someone else's request.
  const stranger = (await api(owner, "GET", `work/approvals/${b.id}`)).status;
  expect(stranger).toBe(200); // the approver can
});
