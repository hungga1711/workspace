// workspace AI Insights: runs only on the company's own workspace, and only after the person allowed it on the
// options page. It copies the id of the task opened last (which the web app keeps in this browser) so a prompt
// sent soon after can carry it as a hint; the person confirms the link in Của tôi › AI. Nothing else is read.
(() => {
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem("workspace.lastTaskSeen") || "null");
      if (v && typeof v.taskId === "string" && /^[A-Za-z0-9_-]{10,40}$/.test(v.taskId) && !Number.isNaN(Date.parse(v.at)))
        chrome.storage.local.set({ lastTaskSeen: { taskId: v.taskId, seenAt: new Date(v.at).toISOString() } });
    } catch {
      // Unreadable or blocked storage: no hint, nothing else changes.
    }
  };
  read();
  window.addEventListener("workspace:task-seen", read);
  document.addEventListener("visibilitychange", read);
})();
