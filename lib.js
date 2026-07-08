/**
 * lib.js — realestate-mcp 순수 로직 (부작용 없음, 테스트에서 직접 import)
 *
 * 계약월 계산, 금액/면적 파싱, 평당가 계산, 응답 정규화, data.go.kr 오류 응답 파싱을 담당.
 * 네트워크 호출(fetch)이나 MCP 서버 기동 코드는 server.js에만 있다.
 */

import { XMLParser } from "fast-xml-parser";

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

export function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** data.go.kr 두 가지 오류 형태(게이트웨이 OpenAPI_ServiceResponse / 서비스 response.header)를 모두 처리해 items를 반환 */
export function parseApiResponse(text) {
  if (/^\s*Unauthorized/i.test(text)) {
    throw new Error(
      "인증키가 거부되었습니다 (Unauthorized). 공공데이터포털에서 이 API의 활용신청이 승인됐는지, key.txt에 붙여넣은 키가 '일반 인증키(Decoding)'인지 확인하세요."
    );
  }

  let doc;
  try {
    doc = xml.parse(text);
  } catch {
    throw new Error(`API 응답을 해석할 수 없습니다: ${String(text).slice(0, 200)}`);
  }

  // 게이트웨이 수준 오류 (잘못된 키, 트래픽 초과, 서비스 미신청 등)
  if (doc.OpenAPI_ServiceResponse) {
    const h = doc.OpenAPI_ServiceResponse.cmmMsgHeader ?? {};
    throw new Error(`공공데이터포털 오류: ${h.returnAuthMsg || h.errMsg || "알 수 없는 오류"} (코드 ${h.returnReasonCode ?? "?"})`);
  }

  const header = doc.response?.header;
  const resultCode = String(header?.resultCode ?? "");
  // 이 API 계열은 성공 코드가 "000"(3자리)으로 온다. nonpay-mcp 계열의 "00"/"0"과 다르므로
  // 앞자리 0을 제거한 값으로 비교해 "0", "00", "000" 모두 성공으로 인식한다.
  if (resultCode.replace(/^0+/, "") !== "") {
    throw new Error(`API 오류 [${resultCode}]: ${header?.resultMsg ?? "알 수 없는 오류"}`);
  }

  const body = doc.response?.body ?? {};
  return {
    items: toArray(body.items?.item),
    totalCount: Number(body.totalCount ?? 0),
    pageNo: Number(body.pageNo ?? 1),
  };
}

// ---------- 계약년월 처리 ----------

/** YYYYMM 형식 검증. 없으면 이번 달. */
export function resolveDealMonth(input) {
  if (input) {
    const s = String(input).trim();
    if (!/^\d{6}$/.test(s)) throw new Error(`계약년월(dealMonth)은 YYYYMM 6자리 형식이어야 합니다: "${s}"`);
    return s;
  }
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** YYYYMM에서 n개월 전 YYYYMM 계산 */
export function monthsBefore(yyyymm, n) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  const d = new Date(y, m - 1 - n, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------- 숫자/금액 파싱 ----------

/** 실거래가 API 금액 필드(예: " 50,000", "50,000") → 숫자(만원 단위) */
export function cleanAmount(v) {
  if (v === undefined || v === null) return NaN;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/** 전용면적(㎡, 문자열 가능) → 숫자 */
export function cleanArea(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export const PYEONG = 3.305785; // 1평 = 3.305785㎡

/** 만원 단위 금액 → "3억 5,000만원" 형태 */
export function fmtManwon(manwon) {
  const n = Number(manwon);
  if (!Number.isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n));
  const eok = Math.floor(abs / 10000);
  const rest = abs % 10000;
  if (eok === 0) return `${sign}${rest.toLocaleString("ko-KR")}만원`;
  if (rest === 0) return `${sign}${eok}억원`;
  return `${sign}${eok}억 ${rest.toLocaleString("ko-KR")}만원`;
}

/** 거래금액(만원) + 전용면적(㎡) → 평당가(만원/평) */
export function pyeongPrice(dealManwon, areaM2) {
  if (!Number.isFinite(dealManwon) || !Number.isFinite(areaM2) || areaM2 <= 0) return NaN;
  const pyeong = areaM2 / PYEONG;
  return dealManwon / pyeong;
}

/** 거래금액(만원) + 전용면적(㎡) → ㎡당가(만원/㎡) */
export function m2Price(dealManwon, areaM2) {
  if (!Number.isFinite(dealManwon) || !Number.isFinite(areaM2) || areaM2 <= 0) return NaN;
  return dealManwon / areaM2;
}

// ---------- 응답 정규화 ----------

export function normalizeTrade(it) {
  const dealAmount = cleanAmount(it.dealAmount);
  const area = cleanArea(it.excluUseAr ?? it.exclUseAr);
  const dealYear = it.dealYear ?? it.dealYmd?.slice?.(0, 4);
  const dealMonth = it.dealMonth ?? it.dealYmd?.slice?.(4, 6);
  const dealDay = it.dealDay ?? it.dealYmd?.slice?.(6, 8);
  return {
    아파트명: String(it.aptNm ?? "").trim(),
    법정동: String(it.umdNm ?? "").trim(),
    지번: String(it.jibun ?? "").trim(),
    도로명: String(it.roadNm ?? "").trim(),
    전용면적: area,
    층: it.floor !== undefined ? Number(it.floor) : undefined,
    건축년도: it.buildYear !== undefined ? Number(it.buildYear) : undefined,
    계약일: [dealYear, dealMonth, dealDay].filter(Boolean).join("-"),
    거래금액만원: dealAmount,
    평당가만원: Math.round(pyeongPrice(dealAmount, area)) || undefined,
    해제여부: it.cdealType ? String(it.cdealType).trim() : undefined,
  };
}

export function fmtTradeRow(row) {
  const cancel = row.해제여부 ? " [해제됨]" : "";
  const py = Number.isFinite(row.평당가만원) ? `, 평당 ${fmtManwon(row.평당가만원)}` : "";
  return (
    `- ${row.아파트명 || "?"} | ${row.법정동}${row.지번 ? " " + row.지번 : ""} | ` +
    `전용 ${row.전용면적}㎡ | ${row.층 ?? "?"}층 | ${row.건축년도 ?? "?"}년 건축 | ` +
    `계약 ${row.계약일} | ${fmtManwon(row.거래금액만원)}${py}${cancel}`
  );
}

export function normalizeRent(it) {
  const deposit = cleanAmount(it.deposit);
  const monthlyRent = cleanAmount(it.monthlyRent);
  const area = cleanArea(it.excluUseAr ?? it.exclUseAr);
  const dealYear = it.dealYear ?? it.year;
  const dealMonth = it.dealMonth ?? it.month;
  const dealDay = it.dealDay ?? it.day;
  return {
    아파트명: String(it.aptNm ?? "").trim(),
    법정동: String(it.umdNm ?? "").trim(),
    지번: String(it.jibun ?? "").trim(),
    전용면적: area,
    층: it.floor !== undefined ? Number(it.floor) : undefined,
    건축년도: it.buildYear !== undefined ? Number(it.buildYear) : undefined,
    계약일: [dealYear, dealMonth, dealDay].filter(Boolean).join("-"),
    계약구분: monthlyRent > 0 ? "월세" : "전세",
    보증금만원: deposit,
    월세만원: monthlyRent,
    계약기간: it.contractTerm ? String(it.contractTerm).trim() : undefined,
    갱신요구권사용: it.useRRRight ? String(it.useRRRight).trim() : undefined,
  };
}

export function fmtRentRow(row) {
  const rent = row.계약구분 === "월세" ? `보증금 ${fmtManwon(row.보증금만원)} / 월세 ${fmtManwon(row.월세만원)}` : `전세 ${fmtManwon(row.보증금만원)}`;
  const renew = row.갱신요구권사용 && row.갱신요구권사용 !== "-" ? ` (갱신권 사용)` : "";
  return (
    `- ${row.아파트명 || "?"} | ${row.법정동}${row.지번 ? " " + row.지번 : ""} | ` +
    `전용 ${row.전용면적}㎡ | ${row.층 ?? "?"}층 | ${row.건축년도 ?? "?"}년 건축 | ` +
    `계약 ${row.계약일} | ${rent}${renew}`
  );
}

export function filterByName(rows, apartmentName) {
  if (!apartmentName) return rows;
  const kw = apartmentName.replace(/\s+/g, "");
  return rows.filter((r) => r.아파트명.replace(/\s+/g, "").includes(kw));
}

// ---------- 분양권전매 ----------

export function normalizePresale(it) {
  const dealAmount = cleanAmount(it.dealAmount);
  const area = cleanArea(it.excluUseAr);
  return {
    아파트명: String(it.aptNm ?? "").trim(),
    법정동: String(it.umdNm ?? "").trim(),
    지번: String(it.jibun ?? "").trim(),
    전용면적: area,
    층: it.floor !== undefined ? Number(it.floor) : undefined,
    계약일: [it.dealYear, it.dealMonth, it.dealDay].filter(Boolean).join("-"),
    거래금액만원: dealAmount,
    평당가만원: Math.round(pyeongPrice(dealAmount, area)) || undefined,
    권리구분: it.ownershipGbn ? String(it.ownershipGbn).trim() : undefined,
    해제여부: it.cdealType && String(it.cdealType).trim() ? String(it.cdealType).trim() : undefined,
  };
}

export function fmtPresaleRow(row) {
  const cancel = row.해제여부 ? " [해제됨]" : "";
  const py = Number.isFinite(row.평당가만원) ? `, 평당 ${fmtManwon(row.평당가만원)}` : "";
  const right = row.권리구분 ? ` (${row.권리구분})` : "";
  return (
    `- ${row.아파트명 || "?"} | ${row.법정동}${row.지번 ? " " + row.지번 : ""} | ` +
    `전용 ${row.전용면적}㎡ | ${row.층 ?? "?"}층 | 계약 ${row.계약일} | ${fmtManwon(row.거래금액만원)}${py}${right}${cancel}`
  );
}

// ---------- 토지 매매 ----------

export function normalizeLand(it) {
  const dealAmount = cleanAmount(it.dealAmount);
  const area = cleanArea(it.dealArea);
  return {
    법정동: String(it.umdNm ?? "").trim(),
    지번: String(it.jibun ?? "").trim(),
    지목: it.jimok ? String(it.jimok).trim() : undefined,
    용도지역: it.landUse ? String(it.landUse).trim() : undefined,
    거래면적: area,
    계약일: [it.dealYear, it.dealMonth, it.dealDay].filter(Boolean).join("-"),
    거래금액만원: dealAmount,
    m2당가만원: Math.round(m2Price(dealAmount, area)) || undefined,
    지분거래: it.shareDealingType && String(it.shareDealingType).trim() ? String(it.shareDealingType).trim() : undefined,
    해제여부: it.cdealType && String(it.cdealType).trim() ? String(it.cdealType).trim() : undefined,
  };
}

export function fmtLandRow(row) {
  const cancel = row.해제여부 ? " [해제됨]" : "";
  const m2 = Number.isFinite(row.m2당가만원) ? `, ㎡당 ${fmtManwon(row.m2당가만원)}` : "";
  const share = row.지분거래 ? ` (지분거래: ${row.지분거래})` : "";
  return (
    `- ${row.법정동}${row.지번 ? " " + row.지번 : ""} | ${row.지목 ?? "?"} | ${row.용도지역 ?? "?"} | ` +
    `거래면적 ${row.거래면적}㎡ | 계약 ${row.계약일} | ${fmtManwon(row.거래금액만원)}${m2}${share}${cancel}`
  );
}

// ---------- 상업업무용 부동산 매매 ----------

export function normalizeCommercial(it) {
  const dealAmount = cleanAmount(it.dealAmount);
  const area = cleanArea(it.buildingAr);
  return {
    법정동: String(it.umdNm ?? "").trim(),
    지번: String(it.jibun ?? "").trim(),
    건물유형: it.buildingType ? String(it.buildingType).trim() : undefined,
    건물주용도: it.buildingUse ? String(it.buildingUse).trim() : undefined,
    용도지역: it.landUse ? String(it.landUse).trim() : undefined,
    건물면적: area,
    층: it.floor !== undefined && String(it.floor).trim() !== "" ? Number(it.floor) : undefined,
    건축년도: it.buildYear !== undefined && String(it.buildYear).trim() !== "" ? Number(it.buildYear) : undefined,
    계약일: [it.dealYear, it.dealMonth, it.dealDay].filter(Boolean).join("-"),
    거래금액만원: dealAmount,
    m2당가만원: Math.round(m2Price(dealAmount, area)) || undefined,
    지분거래: it.shareDealingType && String(it.shareDealingType).trim() ? String(it.shareDealingType).trim() : undefined,
    해제여부: it.cdealType && String(it.cdealType).trim() ? String(it.cdealType).trim() : undefined,
  };
}

export function fmtCommercialRow(row) {
  const cancel = row.해제여부 ? " [해제됨]" : "";
  const m2 = Number.isFinite(row.m2당가만원) ? `, ㎡당 ${fmtManwon(row.m2당가만원)}` : "";
  return (
    `- ${row.법정동}${row.지번 ? " " + row.지번 : ""} | ${row.건물유형 ?? "?"}/${row.건물주용도 ?? "?"} | ` +
    `건물면적 ${row.건물면적}㎡ | ${row.층 ?? "?"}층 | ${row.건축년도 ?? "?"}년 건축 | ` +
    `계약 ${row.계약일} | ${fmtManwon(row.거래금액만원)}${m2}${cancel}`
  );
}

// ---------- 단독/다가구 매매 ----------

export function normalizeDetached(it) {
  const dealAmount = cleanAmount(it.dealAmount);
  const area = cleanArea(it.totalFloorAr);
  return {
    법정동: String(it.umdNm ?? "").trim(),
    지번: String(it.jibun ?? "").trim(),
    주택유형: it.houseType ? String(it.houseType).trim() : undefined,
    대지면적: cleanArea(it.plottageAr),
    연면적: area,
    건축년도: it.buildYear !== undefined && String(it.buildYear).trim() !== "" ? Number(it.buildYear) : undefined,
    계약일: [it.dealYear, it.dealMonth, it.dealDay].filter(Boolean).join("-"),
    거래금액만원: dealAmount,
    m2당가만원: Math.round(m2Price(dealAmount, area)) || undefined,
    해제여부: it.cdealType && String(it.cdealType).trim() ? String(it.cdealType).trim() : undefined,
  };
}

export function fmtDetachedRow(row) {
  const cancel = row.해제여부 ? " [해제됨]" : "";
  const m2 = Number.isFinite(row.m2당가만원) ? `, ㎡당 ${fmtManwon(row.m2당가만원)}` : "";
  return (
    `- ${row.법정동}${row.지번 ? " " + row.지번 : ""} | ${row.주택유형 ?? "?"} | ` +
    `대지 ${row.대지면적}㎡ / 연면적 ${row.연면적}㎡ | ${row.건축년도 ?? "?"}년 건축 | ` +
    `계약 ${row.계약일} | ${fmtManwon(row.거래금액만원)}${m2}${cancel}`
  );
}

// ---------- 통계 ----------

export function stat(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const avg = sorted.reduce((s, v) => s + v, 0) / n;
  return { n, min: sorted[0], max: sorted[n - 1], median: mid, avg };
}
