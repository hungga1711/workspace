import { describe, expect, it } from "vitest";
import { rankByMessage, detectSignals } from "./signals";

const now = new Date("2026-10-09T09:00:00+07:00"); // a Friday

describe("detectSignals", () => {
  it("finds explicit and relative deadlines only when there is a deadline cue", () => {
    expect(detectSignals("Gửi báo giá trước 20/11 nhé", now).deadline?.label).toBe("20/11");
    expect(detectSignals("Hạn chót là thứ Hai", now).deadline?.iso).toBe(new Date("2026-10-12T17:00:00+07:00").toISOString());
    expect(detectSignals("Deadline tomorrow", now).deadline?.label).toBe("tomorrow");
    expect(detectSignals("Deadline tomorrow", now, { today: "hôm nay", tomorrow: "ngày mai" }).deadline?.label).toBe("ngày mai");
    expect(detectSignals("Sinh nhật mình 20/11", now).deadline).toBeNull();
  });

  it("reads English day names as the coming one, Vietnamese still working", () => {
    const fivePm = (y: number, m: number, d: number) => new Date(y, m, d, 17, 0, 0).toISOString();
    expect(detectSignals("Send the report by Friday 5pm", now).deadline?.iso).toBe(fivePm(2026, 9, 16));
    expect(detectSignals("<@u1> due Monday please", now).deadline?.iso).toBe(fivePm(2026, 9, 12));
    expect(detectSignals("Deadline next Tuesday", now).deadline?.iso).toBe(fivePm(2026, 9, 13));
    expect(detectSignals("Hạn chót thứ Ba", now).deadline?.iso).toBe(fivePm(2026, 9, 13));
    expect(detectSignals("See you Friday", now).deadline).toBeNull();
    expect(detectSignals("Maybe lunch today", now).deadline).toBeNull();
  });

  it("recognises decisions but not questions about them", () => {
    expect(detectSignals("Chốt dùng màu xanh lá cho nút đặt lịch", now).decision).toBe(true);
    expect(detectSignals("Mình chốt màu xanh được không?", now).decision).toBe(false);
    expect(detectSignals("We decided to ship on Tuesday", now).decision).toBe(true);
  });

  it("recognises blockers", () => {
    expect(detectSignals("Em đang bị chặn vì chưa có API key", now).blocker).toBe(true);
    expect(detectSignals("Đang chờ phản hồi từ bên đối tác", now).blocker).toBe(true);
    expect(detectSignals("Mọi thứ ổn", now)).toEqual({ deadline: null, decision: false, blocker: false, done: false });
  });

  it("ignores mention tokens", () => {
    expect(detectSignals("<@u1> hạn 15/11 nhé", now).deadline?.label).toBe("15/11");
  });
});

describe("finished work", () => {
  it("recognises 'done' messages, not questions about them or blockers", () => {
    expect(detectSignals("Xong phần API thanh toán rồi nhé").done).toBe(true);
    expect(detectSignals("Mình đã deploy bản mới lên staging").done).toBe(true);
    expect(detectSignals("API xong chưa em?").done).toBe(false);
    expect(detectSignals("Landing page done?").done).toBe(false);
    expect(detectSignals("Chưa xong vì đang bị chặn bởi bên đối tác").done).toBe(false);
    expect(detectSignals("Hôm nay trời đẹp").done).toBe(false);
  });

  it("puts the task that shares the most words with the message first", () => {
    const tasks = [
      { code: "T-1", title: "Viết tài liệu onboarding" },
      { code: "T-2", title: "Tích hợp API thanh toán VNPay" },
      { code: "T-3", title: "Sửa lỗi đăng nhập" },
    ];
    expect(rankByMessage("Xong phần API thanh toán rồi", tasks).map((t) => t.code)).toEqual(["T-2", "T-1", "T-3"]);
    expect(rankByMessage("done", tasks).map((t) => t.code)).toEqual(["T-1", "T-2", "T-3"]);
  });
});
