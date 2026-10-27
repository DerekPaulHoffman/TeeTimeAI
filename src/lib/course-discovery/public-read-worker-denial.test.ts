import {describe,expect,it,vi} from "vitest";
import {publicReadWorkerDenialScript,registerPublicReadWorkerDenial} from "./public-read-worker-denial";
import {stagehandSourceWorkerDenialScript} from "./stagehand-source-browser";

describe("native public-read worker denial",()=>{
  it("shares the exact existing Stagehand script and registers it before a page exists",async()=>{
    const addInitScript=vi.fn().mockResolvedValue(undefined);
    await registerPublicReadWorkerDenial({addInitScript});
    expect(addInitScript).toHaveBeenCalledExactlyOnceWith({content:publicReadWorkerDenialScript});
    expect(stagehandSourceWorkerDenialScript).toBe(publicReadWorkerDenialScript);
    expect(publicReadWorkerDenialScript).toContain("'Worker','SharedWorker'");
  });
});
