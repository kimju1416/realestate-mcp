/**
 * smoke.js — 순수 로직 단위 테스트 + MCP 프로토콜 레벨 스모크 테스트
 *
 * 1부: lib.js·lawd-codes.js의 순수 함수(지역코드 해석, 금액/면적 파싱, 포맷, 통계,
 *      data.go.kr 오류 응답 파싱)를 실제 API 키 없이 직접 검증한다.
 * 2부: 서버를 자식 프로세스로 띄우고 JSON-RPC로 initialize → tools/list → tools/call을
 *      보내, 키가 없어도 서버가 죽지 않고 안내 메시지를 돌려주는지 확인한다 (nonpay-mcp와 동일 패턴).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRegion, resolveRegionCodes } from "../lawd-codes.js";
import {
  resolveDealMonth,
  monthsBefore,
  cleanAmount,
  cleanArea,
  fmtManwon,
  pyeongPrice,
  m2Price,
  normalizeTrade,
  normalizeRent,
  parseApiResponse,
  stat,
  filterByName,
} from "../lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "server.js");

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

// ---------- 1부: 순수 로직 단위 테스트 ----------

console.log("-- 1부: 순수 로직 --");

// 지역코드 해석
check("resolveRegion 5자리 코드 그대로 통과", resolveRegion("11680") === "11680");
check("resolveRegion 단일 구 매칭('강남구')", resolveRegion("강남구") === "11680");
check("resolveRegion 다어절 매칭('성남시 분당구')", resolveRegion("성남시 분당구") === "41135");
check("resolveRegion 다어절 매칭('수원시 영통구')", resolveRegion("수원시 영통구") === "41117");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check("resolveRegionCodes 시 전체('수원시') → 하위 구 4곳", same(resolveRegionCodes("수원시"), ["41111", "41113", "41115", "41117"]));
check("resolveRegionCodes 시 전체('경기도 화성시') → 하위 구 4곳", same(resolveRegionCodes("경기도 화성시"), ["41591", "41593", "41595", "41597"]));
check("resolveRegionCodes 시 전체 코드(41110) → 하위 구", resolveRegionCodes("41110").length === 4);
check("resolveRegion 개편 코드: 춘천시 → 51110", resolveRegion("춘천시") === "51110");
check("resolveRegion 개편 코드: 광주 광산구 → 12330", resolveRegion("광주 광산구") === "12330");
check("resolveRegion 옛 시도명: 광주광역시 광산구 → 12330", resolveRegion("광주광역시 광산구") === "12330");
check("resolveRegion 개편 코드: 화성시 동탄구 → 41597", resolveRegion("화성시 동탄구") === "41597");
check("resolveRegion 개편 코드: 검단구 → 28290", resolveRegion("검단구") === "28290");
check("resolveRegion 개편 코드: 군위군 → 27720", resolveRegion("군위군") === "27720");
check("resolveRegion 개편 코드: 전주시 완산구 → 52111", resolveRegion("전주시 완산구") === "52111");
check("resolveRegion 옛 코드 자동 변환(42110 → 51110)", resolveRegion("42110") === "51110");
check("resolveRegion 옛 코드 자동 변환(46130 → 12130)", resolveRegion("46130") === "12130");
try {
  resolveRegion("수원시");
  check("resolveRegion 시 전체는 구 지정 안내", false);
} catch (e) {
  check("resolveRegion 시 전체는 구 지정 안내", /구를 지정/.test(e.message));
}
try {
  resolveRegionCodes("28110");
  check("폐지 코드(인천 중구 28110) 안내", false);
} catch (e) {
  check("폐지 코드(인천 중구 28110) 안내", /제물포구/.test(e.message));
}

try {
  resolveRegion("중구"); // 서울/부산/대구/인천/대전/울산 6곳 존재 → 모호해야 함
  check("resolveRegion 모호한 입력('중구') 에러", false);
} catch (e) {
  check("resolveRegion 모호한 입력('중구') 에러", /여러|모호|시군구가/.test(e.message), e.message.slice(0, 40));
}

try {
  resolveRegion("존재하지않는동네이름123");
  check("resolveRegion 미매칭 에러", false);
} catch (e) {
  check("resolveRegion 미매칭 에러", /code\.go\.kr/.test(e.message));
}

// 계약월 계산
check("resolveDealMonth 형식 검증 통과", resolveDealMonth("202506") === "202506");
check("resolveDealMonth 생략 시 이번 달 형식(YYYYMM)", /^\d{6}$/.test(resolveDealMonth(undefined)));
try {
  resolveDealMonth("2025-06");
  check("resolveDealMonth 잘못된 형식 에러", false);
} catch (e) {
  check("resolveDealMonth 잘못된 형식 에러", /YYYYMM/.test(e.message));
}
check("monthsBefore 1개월 전", monthsBefore("202506", 1) === "202505");
check("monthsBefore 연도 넘김", monthsBefore("202501", 1) === "202412");
check("monthsBefore 0개월(그대로)", monthsBefore("202506", 0) === "202506");

// 금액/면적 파싱
check("cleanAmount 쉼표+공백 제거", cleanAmount(" 50,000") === 50000);
check("cleanAmount 콤마만", cleanAmount("123,456") === 123456);
check("cleanAmount 순수 숫자", cleanAmount(50000) === 50000);
check("cleanAmount 빈값 NaN", Number.isNaN(cleanAmount(undefined)));
check("cleanArea 문자열 면적", cleanArea("84.93") === 84.93);

// 포맷
check("fmtManwon 억+만원", fmtManwon(35000) === "3억 5,000만원");
check("fmtManwon 억원 딱 떨어짐", fmtManwon(30000) === "3억원");
check("fmtManwon 만원 미만", fmtManwon(5000) === "5,000만원");
check("fmtManwon 잘못된 값", fmtManwon("abc") === "-");

// 평당가/㎡당가
const py = pyeongPrice(35000, 84.93); // 3.5억, 전용 84.93㎡(약 25.7평) → 평당 약 1,362만원
check("pyeongPrice 계산 범위", py > 1300 && py < 1450, String(Math.round(py)));
const m2 = m2Price(35000, 84.93);
check("m2Price 계산 범위", m2 > 400 && m2 < 420, String(Math.round(m2)));
check("pyeongPrice 면적 0이면 NaN", Number.isNaN(pyeongPrice(35000, 0)));

// 응답 정규화 (실제 API 필드명 샘플 기반)
const tradeItem = {
  aptNm: "중곡2단지", umdNm: "중곡동", jibun: "190-26", roadNm: "능동로 90",
  excluUseAr: "55.87", dealYear: "2025", dealMonth: "6", dealDay: "15",
  dealAmount: " 45,000", floor: "7", buildYear: "1996",
};
const nt = normalizeTrade(tradeItem);
check("normalizeTrade 아파트명", nt.아파트명 === "중곡2단지");
check("normalizeTrade 거래금액 파싱", nt.거래금액만원 === 45000);
check("normalizeTrade 계약일 조합", nt.계약일 === "2025-6-15");
check("normalizeTrade 평당가 계산됨", Number.isFinite(nt.평당가만원));

const rentItemJeonse = {
  aptNm: "래미안", umdNm: "역삼동", jibun: "700-1", excluUseAr: "59.98",
  buildYear: "2005", floor: "10", dealYear: "2025", dealMonth: "6", dealDay: "1",
  deposit: " 500,000", monthlyRent: "0",
};
const nrJ = normalizeRent(rentItemJeonse);
check("normalizeRent 전세 판별", nrJ.계약구분 === "전세");
check("normalizeRent 보증금 파싱", nrJ.보증금만원 === 500000);

const rentItemWolse = { ...rentItemJeonse, deposit: " 10,000", monthlyRent: " 150" };
const nrW = normalizeRent(rentItemWolse);
check("normalizeRent 월세 판별", nrW.계약구분 === "월세");
check("normalizeRent 월세금액 파싱", nrW.월세만원 === 150);

// 이름 필터
const filtered = filterByName([{ 아파트명: "래미안 강남" }, { 아파트명: "푸르지오" }], "래미안");
check("filterByName 부분일치", filtered.length === 1 && filtered[0].아파트명 === "래미안 강남");

// 통계
const s = stat([100, 200, 300, 400, 500]);
check("stat 중앙값(홀수개)", s.median === 300);
check("stat 평균", s.avg === 300);
check("stat 최소/최대", s.min === 100 && s.max === 500);
const s2 = stat([100, 200, 300, 400]);
check("stat 중앙값(짝수개)", s2.median === 250);

// data.go.kr 오류 응답 파싱 (두 가지 오류 형태)
const gatewayErrorXml = `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>`;
try {
  parseApiResponse(gatewayErrorXml);
  check("parseApiResponse 게이트웨이 오류 감지", false);
} catch (e) {
  check("parseApiResponse 게이트웨이 오류 감지", /SERVICE_KEY_IS_NOT_REGISTERED_ERROR|30/.test(e.message), e.message);
}

const serviceErrorXml = `<response><header><resultCode>03</resultCode><resultMsg>NODATA_ERROR</resultMsg></header></response>`;
try {
  parseApiResponse(serviceErrorXml);
  check("parseApiResponse 서비스 오류 감지", false);
} catch (e) {
  check("parseApiResponse 서비스 오류 감지", /03|NODATA_ERROR/.test(e.message), e.message);
}

const okXml = `<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items><item><aptNm>테스트</aptNm></item></items><totalCount>1</totalCount><pageNo>1</pageNo></body></response>`;
const parsed = parseApiResponse(okXml);
check("parseApiResponse 정상 응답 파싱", parsed.items.length === 1 && parsed.totalCount === 1);

check("parseApiResponse Unauthorized 문자열 감지", (() => {
  try {
    parseApiResponse("Unauthorized. Invalid Auth. (SERVICE KEY)");
    return false;
  } catch (e) {
    return /인증키가 거부/.test(e.message);
  }
})());

// ---------- 2부: MCP 프로토콜 레벨 스모크 테스트 ----------

console.log("\n-- 2부: MCP 프로토콜 --");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, REALESTATE_API_KEY: process.env.REALESTATE_API_KEY ?? "" },
});

let buf = "";
const pending = new Map();

child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      console.error("[stdout 비JSON]", line.slice(0, 200));
    }
  }
});
child.stderr.on("data", (d) => console.error("[server]", d.toString().trim()));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 응답 타임아웃`));
      }
    }, 30000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  check("initialize 응답", !!init.result?.serverInfo, init.result?.serverInfo?.name);
  notify("notifications/initialized");

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  check("tools/list 도구 7개", tools.length === 7, tools.map((t) => t.name).join(", "));

  const call = await rpc("tools/call", {
    name: "search_apartment_trades",
    arguments: { region: "강남구", dealMonth: "202506" },
  });
  const text = call.result?.content?.[0]?.text ?? "";
  const keyFileHasContent = (() => {
    try {
      const k = readFileSync(join(__dirname, "..", "key.txt"), "utf8").trim();
      return !!k && !k.startsWith("여기에");
    } catch {
      return false;
    }
  })();
  const hasKey = !!(process.env.REALESTATE_API_KEY?.trim()) || keyFileHasContent;
  if (hasKey) {
    check("search_apartment_trades 실데이터 응답", text.length > 0, text.slice(0, 120));
  } else {
    check("키 없음 → 안내 메시지 반환(크래시 없음)", text.includes("인증키"), text.split("\n")[0]);
  }

  console.log(failed === 0 ? "\n스모크 테스트 통과 🎉" : `\n실패 ${failed}건`);
} catch (e) {
  console.error("❌ 테스트 중 오류:", e.message);
  failed++;
} finally {
  child.kill();
  process.exit(failed === 0 ? 0 : 1);
}
