#!/usr/bin/env node
/**
 * realestate-mcp — 국토교통부 부동산 실거래가(아파트) MCP 서버
 *
 * 데이터 출처: 공공데이터포털(data.go.kr), 국토교통부 제공
 *   - 아파트 매매 실거래가 상세 자료: https://www.data.go.kr/data/15126468/openapi.do
 *     오퍼레이션: getRTMSDataSvcAptTradeDev
 *     BASE: https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev
 *   - 아파트 전월세 실거래가 자료: https://www.data.go.kr/data/15126474/openapi.do
 *     오퍼레이션: getRTMSDataSvcAptRent
 *     BASE: https://apis.data.go.kr/1613000/RTMSDataSvcAptRent
 *   두 서비스 모두 개발단계·운영단계 자동승인 (data.go.kr 활용신청 페이지 명시).
 *
 * 요청 파라미터(공통): serviceKey, LAWD_CD(법정동 시군구코드 5자리), DEAL_YMD(계약년월 YYYYMM),
 *   pageNo, numOfRows. 응답은 XML.
 *
 * 인증키: 환경변수 REALESTATE_API_KEY 또는 이 파일 옆의 key.txt
 *
 * 순수 로직(파싱/포맷/통계)은 lib.js에, 지역코드 해석은 lawd-codes.js에 분리해
 * 서버를 기동하지 않고도 test/smoke.js에서 바로 import해 단위 테스트할 수 있게 했다.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRegion } from "./lawd-codes.js";
import {
  parseApiResponse,
  resolveDealMonth,
  monthsBefore,
  pyeongPrice,
  fmtManwon,
  normalizeTrade,
  normalizeRent,
  fmtTradeRow,
  fmtRentRow,
  filterByName,
  filterByDong,
  paginate,
  stat,
  normalizePresale,
  fmtPresaleRow,
  normalizeLand,
  fmtLandRow,
  normalizeCommercial,
  fmtCommercialRow,
  normalizeDetached,
  fmtDetachedRow,
} from "./lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TRADE_BASE = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev";
const TRADE_OP = "getRTMSDataSvcAptTradeDev";
const RENT_BASE = "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent";
const RENT_OP = "getRTMSDataSvcAptRent";
const PRESALE_BASE = "https://apis.data.go.kr/1613000/RTMSDataSvcSilvTrade";
const PRESALE_OP = "getRTMSDataSvcSilvTrade";
const LAND_BASE = "https://apis.data.go.kr/1613000/RTMSDataSvcLandTrade";
const LAND_OP = "getRTMSDataSvcLandTrade";
const COMMERCIAL_BASE = "https://apis.data.go.kr/1613000/RTMSDataSvcNrgTrade";
const COMMERCIAL_OP = "getRTMSDataSvcNrgTrade";
const DETACHED_BASE = "https://apis.data.go.kr/1613000/RTMSDataSvcSHTrade";
const DETACHED_OP = "getRTMSDataSvcSHTrade";

const KEY_GUIDE = [
  "공공데이터포털 인증키가 설정되지 않았습니다. 설정 방법:",
  "1. https://www.data.go.kr 회원가입 후 로그인",
  "2. 아래 두 서비스를 각각 검색해 활용신청 (둘 다 개발단계 자동승인, 즉시 발급)",
  "   - '국토교통부_아파트 매매 실거래가 상세 자료' https://www.data.go.kr/data/15126468/openapi.do",
  "   - '국토교통부_아파트 전월세 실거래가 자료'   https://www.data.go.kr/data/15126474/openapi.do",
  "   ※ 두 서비스는 별도 신청이지만, 발급되는 인증키(개인 서비스키)는 계정 공통 키 하나만 있으면 됩니다.",
  "3. 마이페이지 > 인증키 발급현황에서 '일반 인증키(Decoding)' 복사",
  `4. 아래 파일에 키를 붙여넣고 저장: ${join(__dirname, "key.txt")}`,
  "   (또는 환경변수 REALESTATE_API_KEY 로 설정)",
  "5. 운영계정 트래픽은 기본 10,000회/일이며, 신청 직후에도 반영까지 몇 분 걸릴 수 있습니다.",
].join("\n");

function getKey() {
  if (process.env.REALESTATE_API_KEY?.trim()) return process.env.REALESTATE_API_KEY.trim();
  const keyFile = join(__dirname, "key.txt");
  if (existsSync(keyFile)) {
    const k = readFileSync(keyFile, "utf8").trim();
    if (k && !k.startsWith("여기에")) return k;
  }
  return null;
}

async function callApi(base, op, params = {}) {
  const key = getKey();
  if (!key) throw new Error(KEY_GUIDE);

  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  // 키에 %가 있으면 이미 URL 인코딩된 키(Encoding key)로 보고 그대로 사용
  const keyParam = key.includes("%") ? key : encodeURIComponent(key);
  const url = `${base}/${op}?serviceKey=${keyParam}${qs ? "&" + qs : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let text;
  try {
    const res = await fetch(url, { signal: controller.signal });
    text = await res.text();
  } catch (e) {
    throw new Error(`API 호출 실패 (네트워크): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  return parseApiResponse(text);
}

async function fetchTrades(lawdCd, dealMonth, { pageNo = 1, numOfRows = 1000 } = {}) {
  const { items, totalCount } = await callApi(TRADE_BASE, TRADE_OP, {
    LAWD_CD: lawdCd,
    DEAL_YMD: dealMonth,
    pageNo,
    numOfRows,
  });
  return { rows: items.map(normalizeTrade), totalCount };
}

async function fetchRents(lawdCd, dealMonth, { pageNo = 1, numOfRows = 1000 } = {}) {
  const { items, totalCount } = await callApi(RENT_BASE, RENT_OP, {
    LAWD_CD: lawdCd,
    DEAL_YMD: dealMonth,
    pageNo,
    numOfRows,
  });
  return { rows: items.map(normalizeRent), totalCount };
}

async function fetchPresale(lawdCd, dealMonth, { pageNo = 1, numOfRows = 1000 } = {}) {
  const { items, totalCount } = await callApi(PRESALE_BASE, PRESALE_OP, {
    LAWD_CD: lawdCd,
    DEAL_YMD: dealMonth,
    pageNo,
    numOfRows,
  });
  return { rows: items.map(normalizePresale), totalCount };
}

async function fetchLand(lawdCd, dealMonth, { pageNo = 1, numOfRows = 1000 } = {}) {
  const { items, totalCount } = await callApi(LAND_BASE, LAND_OP, {
    LAWD_CD: lawdCd,
    DEAL_YMD: dealMonth,
    pageNo,
    numOfRows,
  });
  return { rows: items.map(normalizeLand), totalCount };
}

async function fetchCommercial(lawdCd, dealMonth, { pageNo = 1, numOfRows = 1000 } = {}) {
  const { items, totalCount } = await callApi(COMMERCIAL_BASE, COMMERCIAL_OP, {
    LAWD_CD: lawdCd,
    DEAL_YMD: dealMonth,
    pageNo,
    numOfRows,
  });
  return { rows: items.map(normalizeCommercial), totalCount };
}

async function fetchDetached(lawdCd, dealMonth, { pageNo = 1, numOfRows = 1000 } = {}) {
  const { items, totalCount } = await callApi(DETACHED_BASE, DETACHED_OP, {
    LAWD_CD: lawdCd,
    DEAL_YMD: dealMonth,
    pageNo,
    numOfRows,
  });
  return { rows: items.map(normalizeDetached), totalCount };
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({ content: [{ type: "text", text: `⚠️ ${e.message}` }], isError: true });

// ---------- MCP 서버 ----------
// HTTP(원격) 모드에서는 요청마다 새 서버 인스턴스를 만들어 세션을 완전히 분리한다(무상태).
// stdio(로컬) 모드에서는 이 함수를 한 번만 호출해 프로세스 수명 동안 하나의 인스턴스를 쓴다.

function createServer() {
  const server = new McpServer({ name: "realestate-mcp", version: "0.1.0" });

  server.registerTool(
  "search_apartment_trades",
  {
    title: "아파트 매매 실거래가 조회",
    description:
      "국토교통부 실거래가 자료로 특정 지역·월의 아파트 매매 거래 내역을 조회한다. " +
      "region에는 '강남구', '성남시 분당구', '수원시 영통구'처럼 시군구명을 넣거나, " +
      "5자리 법정동코드(LAWD_CD)를 직접 넣어도 된다. dealMonth를 생략하면 이번 달 기준으로 조회한다 " +
      "(실거래 신고 특성상 최근 1~2개월 자료는 아직 신고 전이라 적거나 없을 수 있음 — 그럴 땐 지난 달을 지정해보라고 안내). " +
      "region은 시군구 단위까지만 구분하므로, 읍/면/동 단위로 더 좁히려면 dong 파라미터를 쓴다.",
    inputSchema: {
      region: z.string().describe("지역명(시군구, 예: '강남구', '성남시 분당구') 또는 5자리 법정동코드"),
      dealMonth: z.string().optional().describe("계약년월 YYYYMM (예: '202506'). 생략 시 이번 달"),
      apartmentName: z.string().optional().describe("아파트 단지명 부분 필터 (예: '래미안')"),
      dong: z.string().optional().describe("읍/면/동 이름 부분 필터 (예: '봉곡동'). region은 시군구 단위까지만 지원하므로 동 단위로 좁힐 때 사용"),
      page: z.number().int().min(1).optional().describe("결과 페이지 번호 (한 페이지 50건, 기본 1) — 이미 조회한 결과를 넘겨볼 때 사용"),
    },
  },
  async ({ region, dealMonth, apartmentName, dong, page }) => {
    try {
      const lawdCd = resolveRegion(region);
      const ym = resolveDealMonth(dealMonth);
      const { rows, totalCount } = await fetchTrades(lawdCd, ym);
      const filtered = filterByDong(filterByName(rows, apartmentName), dong);

      if (filtered.length === 0) {
        const hint =
          totalCount === 0
            ? ` 해당 월 자료가 아직 없을 수 있습니다. dealMonth를 지난 달(예: ${monthsBefore(ym, 1)})로 지정해보세요.`
            : "";
        return ok(`조건에 맞는 매매 거래가 없습니다 (${ym}).${hint}`);
      }

      filtered.sort((a, b) => (a.계약일 < b.계약일 ? 1 : -1));
      const pageRows = paginate(filtered, page ?? 1);
      const header = `[${region}${dong ? " " + dong : ""} · ${ym}] 아파트 매매 실거래 ${filtered.length}건 (전체 ${totalCount}건 중):`;
      const note = filtered.length > 50 ? `\n\n※ ${(page ?? 1)}페이지(50건) 표시. 더 필요하면 page 지정.` : "";
      return ok(`${header}\n${pageRows.map(fmtTradeRow).join("\n")}${note}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_apartment_rent",
  {
    title: "아파트 전월세 실거래가 조회",
    description:
      "국토교통부 실거래가 자료로 특정 지역·월의 아파트 전월세(전세/월세) 거래 내역을 조회한다. " +
      "region·dealMonth·apartmentName·dong 사용법은 search_apartment_trades와 동일하다.",
    inputSchema: {
      region: z.string().describe("지역명(시군구, 예: '강남구', '성남시 분당구') 또는 5자리 법정동코드"),
      dealMonth: z.string().optional().describe("계약년월 YYYYMM (예: '202506'). 생략 시 이번 달"),
      apartmentName: z.string().optional().describe("아파트 단지명 부분 필터"),
      dong: z.string().optional().describe("읍/면/동 이름 부분 필터 (예: '봉곡동'). region은 시군구 단위까지만 지원하므로 동 단위로 좁힐 때 사용"),
      page: z.number().int().min(1).optional().describe("결과 페이지 번호 (한 페이지 50건, 기본 1) — 이미 조회한 결과를 넘겨볼 때 사용"),
    },
  },
  async ({ region, dealMonth, apartmentName, dong, page }) => {
    try {
      const lawdCd = resolveRegion(region);
      const ym = resolveDealMonth(dealMonth);
      const { rows, totalCount } = await fetchRents(lawdCd, ym);
      const filtered = filterByDong(filterByName(rows, apartmentName), dong);

      if (filtered.length === 0) {
        const hint =
          totalCount === 0
            ? ` 해당 월 자료가 아직 없을 수 있습니다. dealMonth를 지난 달(예: ${monthsBefore(ym, 1)})로 지정해보세요.`
            : "";
        return ok(`조건에 맞는 전월세 거래가 없습니다 (${ym}).${hint}`);
      }

      filtered.sort((a, b) => (a.계약일 < b.계약일 ? 1 : -1));
      const pageRows = paginate(filtered, page ?? 1);
      const header = `[${region}${dong ? " " + dong : ""} · ${ym}] 아파트 전월세 실거래 ${filtered.length}건 (전체 ${totalCount}건 중):`;
      const note = filtered.length > 50 ? `\n\n※ ${(page ?? 1)}페이지(50건) 표시. 더 필요하면 page 지정.` : "";
      return ok(`${header}\n${pageRows.map(fmtRentRow).join("\n")}${note}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "price_stats",
  {
    title: "아파트 시세 통계 (지역별)",
    description:
      "특정 지역의 최근 N개월 아파트 매매(또는 전월세) 거래금액을 집계해 " +
      "최저/중앙값/평균/최고와 평당가를 계산한다. '이 동네 시세 어때?' 질문에 사용. " +
      "groupBy='apartment'로 지정하면 단지별로 나눠서 보여준다.",
    inputSchema: {
      region: z.string().describe("지역명(시군구) 또는 5자리 법정동코드"),
      dealMonth: z.string().optional().describe("기준 계약년월 YYYYMM. 생략 시 이번 달을 기준으로 최근 개월을 거슬러 올라감"),
      recentMonths: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("기준월 포함 최근 몇 개월을 합산할지 (기본 1, 최대 3 — 과도한 호출 방지)"),
      dealType: z.enum(["trade", "rent"]).optional().describe("'trade'(매매, 기본) 또는 'rent'(전월세)"),
      apartmentName: z.string().optional().describe("특정 단지만 집계하고 싶을 때 부분 필터"),
      dong: z.string().optional().describe("읍/면/동 이름 부분 필터 (예: '봉곡동'). region은 시군구 단위까지만 지원하므로 동 단위로 좁힐 때 사용"),
      groupBy: z.enum(["overall", "apartment"]).optional().describe("집계 단위: 'overall'(전체, 기본) 또는 'apartment'(단지별)"),
    },
  },
  async ({ region, dealMonth, recentMonths, dealType, apartmentName, dong, groupBy }) => {
    try {
      const lawdCd = resolveRegion(region);
      const baseYm = resolveDealMonth(dealMonth);
      const months = recentMonths ?? 1;
      const type = dealType ?? "trade";
      const fetcher = type === "rent" ? fetchRents : fetchTrades;

      let all = [];
      for (let i = 0; i < months; i++) {
        const ym = monthsBefore(baseYm, i);
        const { rows } = await fetcher(lawdCd, ym, { pageNo: 1, numOfRows: 1000 });
        all.push(...rows);
      }
      all = filterByDong(filterByName(all, apartmentName), dong);

      const amountOf = (r) => (type === "rent" ? r.보증금만원 : r.거래금액만원);
      const usable = all.filter((r) => Number.isFinite(amountOf(r)) && amountOf(r) > 0);

      if (usable.length === 0) {
        return ok(
          `[${region}${dong ? " " + dong : ""}] 집계할 데이터가 없습니다 (${baseYm} 기준 최근 ${months}개월, ${
            type === "rent" ? "전월세" : "매매"
          }). 다른 달이나 인접 개월을 지정해보세요.`
        );
      }

      const keyOf = (r) => (groupBy === "apartment" ? r.아파트명 || "?" : "전체");
      const groups = new Map();
      for (const r of usable) {
        const k = keyOf(r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }

      const rowsOut = [...groups.entries()].map(([k, rs]) => {
        const amounts = rs.map(amountOf);
        const s = stat(amounts);
        const pyeongPrices = rs.map((r) => pyeongPrice(amountOf(r), r.전용면적)).filter((v) => Number.isFinite(v));
        const avgPyeong = pyeongPrices.length ? pyeongPrices.reduce((a, b) => a + b, 0) / pyeongPrices.length : NaN;
        return { k, s, avgPyeong, count: rs.length };
      });
      rowsOut.sort((a, b) => b.s.median - a.s.median);

      const label = type === "rent" ? "보증금(전세환산)" : "거래금액";
      const lines = rowsOut.map(
        ({ k, s, avgPyeong, count }) =>
          `- ${k}: ${count}건 | 최저 ${fmtManwon(s.min)} | 중앙값 ${fmtManwon(s.median)} | 평균 ${fmtManwon(
            Math.round(s.avg)
          )} | 최고 ${fmtManwon(s.max)}` + (Number.isFinite(avgPyeong) ? ` | 평균 평당가 ${fmtManwon(Math.round(avgPyeong))}` : "")
      );

      const unit = groupBy === "apartment" ? "단지별" : "전체";
      const period = months > 1 ? `${monthsBefore(baseYm, months - 1)}~${baseYm}` : baseYm;
      return ok(
        `[${region}${dong ? " " + dong : ""}] ${period} ${type === "rent" ? "전월세(보증금 기준)" : "매매"} ${unit} 시세 (${label}):\n${lines.join("\n")}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_presale_trades",
  {
    title: "아파트 분양권전매 실거래가 조회",
    description:
      "국토교통부 실거래가 자료로 특정 지역·월의 아파트 분양권전매(입주권 포함) 거래 내역을 조회한다. " +
      "region·dealMonth·apartmentName·dong 사용법은 search_apartment_trades와 동일하다. " +
      "아직 준공 전인 단지라 건축년도 정보는 없다.",
    inputSchema: {
      region: z.string().describe("지역명(시군구, 예: '강남구', '성남시 분당구') 또는 5자리 법정동코드"),
      dealMonth: z.string().optional().describe("계약년월 YYYYMM (예: '202506'). 생략 시 이번 달"),
      apartmentName: z.string().optional().describe("아파트 단지명 부분 필터"),
      dong: z.string().optional().describe("읍/면/동 이름 부분 필터 (예: '봉곡동'). region은 시군구 단위까지만 지원하므로 동 단위로 좁힐 때 사용"),
      page: z.number().int().min(1).optional().describe("결과 페이지 번호 (한 페이지 50건, 기본 1) — 이미 조회한 결과를 넘겨볼 때 사용"),
    },
  },
  async ({ region, dealMonth, apartmentName, dong, page }) => {
    try {
      const lawdCd = resolveRegion(region);
      const ym = resolveDealMonth(dealMonth);
      const { rows, totalCount } = await fetchPresale(lawdCd, ym);
      const filtered = filterByDong(filterByName(rows, apartmentName), dong);

      if (filtered.length === 0) {
        const hint =
          totalCount === 0
            ? ` 해당 월 자료가 아직 없을 수 있습니다. dealMonth를 지난 달(예: ${monthsBefore(ym, 1)})로 지정해보세요.`
            : "";
        return ok(`조건에 맞는 분양권전매 거래가 없습니다 (${ym}).${hint}`);
      }

      filtered.sort((a, b) => (a.계약일 < b.계약일 ? 1 : -1));
      const pageRows = paginate(filtered, page ?? 1);
      const header = `[${region}${dong ? " " + dong : ""} · ${ym}] 아파트 분양권전매 실거래 ${filtered.length}건 (전체 ${totalCount}건 중):`;
      const note = filtered.length > 50 ? `\n\n※ ${(page ?? 1)}페이지(50건) 표시. 더 필요하면 page 지정.` : "";
      return ok(`${header}\n${pageRows.map(fmtPresaleRow).join("\n")}${note}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_land_trades",
  {
    title: "토지 매매 실거래가 조회",
    description:
      "국토교통부 실거래가 자료로 특정 지역·월의 토지 매매 거래 내역을 조회한다 (지목·용도지역·거래면적 포함). " +
      "region·dealMonth 사용법은 search_apartment_trades와 동일하다. 단지명 필터는 없다(토지엔 단지명이 없음). " +
      "region은 시군구 단위까지만 구분하므로, 읍/면/동 단위로 더 좁히려면 dong 파라미터를 쓴다.",
    inputSchema: {
      region: z.string().describe("지역명(시군구, 예: '강남구', '성남시 분당구') 또는 5자리 법정동코드"),
      dealMonth: z.string().optional().describe("계약년월 YYYYMM (예: '202506'). 생략 시 이번 달"),
      dong: z.string().optional().describe("읍/면/동 이름 부분 필터 (예: '봉곡동'). region은 시군구 단위까지만 지원하므로 동 단위로 좁힐 때 사용"),
      page: z.number().int().min(1).optional().describe("결과 페이지 번호 (한 페이지 50건, 기본 1) — 이미 조회한 결과를 넘겨볼 때 사용"),
    },
  },
  async ({ region, dealMonth, dong, page }) => {
    try {
      const lawdCd = resolveRegion(region);
      const ym = resolveDealMonth(dealMonth);
      const { rows, totalCount } = await fetchLand(lawdCd, ym);
      const filtered = filterByDong(rows, dong);

      if (filtered.length === 0) {
        const hint = ` 해당 월 자료가 아직 없을 수 있습니다. dealMonth를 지난 달(예: ${monthsBefore(ym, 1)})로 지정해보세요.`;
        return ok(`조건에 맞는 토지 매매 거래가 없습니다 (${ym}).${dong && totalCount > 0 ? "" : hint}`);
      }

      filtered.sort((a, b) => (a.계약일 < b.계약일 ? 1 : -1));
      const pageRows = paginate(filtered, page ?? 1);
      const header = `[${region}${dong ? " " + dong : ""} · ${ym}] 토지 매매 실거래 ${filtered.length}건 (전체 ${totalCount}건 중):`;
      const note = filtered.length > 50 ? `\n\n※ ${(page ?? 1)}페이지(50건) 표시. 더 필요하면 page 지정.` : "";
      return ok(`${header}\n${pageRows.map(fmtLandRow).join("\n")}${note}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_commercial_trades",
  {
    title: "상업업무용 부동산 매매 실거래가 조회",
    description:
      "국토교통부 실거래가 자료로 특정 지역·월의 상가·업무용 부동산(근린생활시설 등) 매매 거래 내역을 조회한다 " +
      "(건물유형·주용도·건물면적·층 포함). region·dealMonth 사용법은 search_apartment_trades와 동일하다. " +
      "단지명 필터는 없다. region은 시군구 단위까지만 구분하므로, 읍/면/동 단위로 더 좁히려면 dong 파라미터를 쓴다.",
    inputSchema: {
      region: z.string().describe("지역명(시군구, 예: '강남구', '성남시 분당구') 또는 5자리 법정동코드"),
      dealMonth: z.string().optional().describe("계약년월 YYYYMM (예: '202506'). 생략 시 이번 달"),
      dong: z.string().optional().describe("읍/면/동 이름 부분 필터 (예: '봉곡동'). region은 시군구 단위까지만 지원하므로 동 단위로 좁힐 때 사용"),
      page: z.number().int().min(1).optional().describe("결과 페이지 번호 (한 페이지 50건, 기본 1) — 이미 조회한 결과를 넘겨볼 때 사용"),
    },
  },
  async ({ region, dealMonth, dong, page }) => {
    try {
      const lawdCd = resolveRegion(region);
      const ym = resolveDealMonth(dealMonth);
      const { rows, totalCount } = await fetchCommercial(lawdCd, ym);
      const filtered = filterByDong(rows, dong);

      if (filtered.length === 0) {
        const hint = ` 해당 월 자료가 아직 없을 수 있습니다. dealMonth를 지난 달(예: ${monthsBefore(ym, 1)})로 지정해보세요.`;
        return ok(`조건에 맞는 상업업무용 매매 거래가 없습니다 (${ym}).${dong && totalCount > 0 ? "" : hint}`);
      }

      filtered.sort((a, b) => (a.계약일 < b.계약일 ? 1 : -1));
      const pageRows = paginate(filtered, page ?? 1);
      const header = `[${region}${dong ? " " + dong : ""} · ${ym}] 상업업무용 부동산 매매 실거래 ${filtered.length}건 (전체 ${totalCount}건 중):`;
      const note = filtered.length > 50 ? `\n\n※ ${(page ?? 1)}페이지(50건) 표시. 더 필요하면 page 지정.` : "";
      return ok(`${header}\n${pageRows.map(fmtCommercialRow).join("\n")}${note}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_detached_house_trades",
  {
    title: "단독/다가구 매매 실거래가 조회",
    description:
      "국토교통부 실거래가 자료로 특정 지역·월의 단독·다가구 주택 매매 거래 내역을 조회한다 " +
      "(대지면적·연면적·건축년도 포함). region·dealMonth 사용법은 search_apartment_trades와 동일하다. " +
      "단지명 필터는 없다. region은 시군구 단위까지만 구분하므로, 읍/면/동 단위로 더 좁히려면 dong 파라미터를 쓴다.",
    inputSchema: {
      region: z.string().describe("지역명(시군구, 예: '강남구', '성남시 분당구') 또는 5자리 법정동코드"),
      dealMonth: z.string().optional().describe("계약년월 YYYYMM (예: '202506'). 생략 시 이번 달"),
      dong: z.string().optional().describe("읍/면/동 이름 부분 필터 (예: '봉곡동'). region은 시군구 단위까지만 지원하므로 동 단위로 좁힐 때 사용"),
      page: z.number().int().min(1).optional().describe("결과 페이지 번호 (한 페이지 50건, 기본 1) — 이미 조회한 결과를 넘겨볼 때 사용"),
    },
  },
  async ({ region, dealMonth, dong, page }) => {
    try {
      const lawdCd = resolveRegion(region);
      const ym = resolveDealMonth(dealMonth);
      const { rows, totalCount } = await fetchDetached(lawdCd, ym);
      const filtered = filterByDong(rows, dong);

      if (filtered.length === 0) {
        const hint = ` 해당 월 자료가 아직 없을 수 있습니다. dealMonth를 지난 달(예: ${monthsBefore(ym, 1)})로 지정해보세요.`;
        return ok(`조건에 맞는 단독/다가구 매매 거래가 없습니다 (${ym}).${dong && totalCount > 0 ? "" : hint}`);
      }

      filtered.sort((a, b) => (a.계약일 < b.계약일 ? 1 : -1));
      const pageRows = paginate(filtered, page ?? 1);
      const header = `[${region}${dong ? " " + dong : ""} · ${ym}] 단독/다가구 매매 실거래 ${filtered.length}건 (전체 ${totalCount}건 중):`;
      const note = filtered.length > 50 ? `\n\n※ ${(page ?? 1)}페이지(50건) 표시. 더 필요하면 page 지정.` : "";
      return ok(`${header}\n${pageRows.map(fmtDetachedRow).join("\n")}${note}`);
    } catch (e) {
      return fail(e);
    }
  }
  );

  return server;
}

// ---------- 원격(HTTP) 모드 ----------
// Render 등에 배포될 때 PORT 환경변수가 설정된다. 이때는 무상태(stateless) StreamableHTTP로
// 요청마다 새 McpServer+transport를 만들어 세션을 완전히 분리한다(세션 저장소 불필요).
// 개인 소유 인증키 하나를 불특정 다수가 공유하므로, IP당 분당 요청 수를 아주 단순하게 제한한다.

function createRateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now > rec.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      res.status(429).json({ error: "요청이 너무 많습니다. 1분 후 다시 시도하세요." });
      return;
    }
    next();
  };
}

async function runHttpServer(port) {
  const app = express();
  app.use(express.json());
  app.use("/mcp", createRateLimiter());

  app.get("/", (_req, res) => res.send("realestate-mcp is running"));

  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP 요청 처리 오류:", e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // 무상태 모드라 GET(서버→클라 스트림)·DELETE(세션 종료)는 지원하지 않음을 명시적으로 응답
  app.get("/mcp", (_req, res) => res.status(405).json({ error: "이 서버는 무상태(stateless) 모드입니다." }));
  app.delete("/mcp", (_req, res) => res.status(405).json({ error: "이 서버는 무상태(stateless) 모드입니다." }));

  app.listen(port, () => {
    console.error(`realestate-mcp HTTP 서버 시작됨 (port ${port})`);
  });
}

if (process.env.PORT) {
  await runHttpServer(Number(process.env.PORT));
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("realestate-mcp 서버 시작됨 (stdio)");
}
