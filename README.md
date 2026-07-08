# realestate-mcp — 부동산 실거래가 MCP 서버

국토교통부가 공공데이터포털(data.go.kr)에 공개하는 **아파트 매매/전월세 실거래가**를
Claude에게 자연어로 물어보면 답해주는 MCP 서버입니다.

- 데이터 출처:
  - [국토교통부_아파트 매매 실거래가 상세 자료](https://www.data.go.kr/data/15126468/openapi.do) (`getRTMSDataSvcAptTradeDev`)
  - [국토교통부_아파트 전월세 실거래가 자료](https://www.data.go.kr/data/15126474/openapi.do) (`getRTMSDataSvcAptRent`)
  - [국토교통부_아파트 분양권전매 실거래가 자료](https://www.data.go.kr/data/15126471/openapi.do) (`getRTMSDataSvcSilvTrade`)
  - [국토교통부_토지 매매 실거래가 자료](https://www.data.go.kr/data/15126466/openapi.do) (`getRTMSDataSvcLandTrade`)
  - [국토교통부_상업업무용 부동산 매매 실거래가 자료](https://www.data.go.kr/data/15126463/openapi.do) (`getRTMSDataSvcNrgTrade`)
  - [국토교통부_단독/다가구 매매 실거래가 자료](https://www.data.go.kr/data/15126465/openapi.do) (`getRTMSDataSvcSHTrade`)
- 실행 환경: Node.js 18+ (fetch 내장 버전)

## 제공 도구

| 도구 | 하는 일 |
|---|---|
| `search_apartment_trades` | 지역·월 기준 아파트 매매 실거래 내역 (아파트명/지번/전용면적/층/건축년도/계약일/거래금액, 평당가 포함) |
| `search_apartment_rent` | 지역·월 기준 아파트 전월세 실거래 내역 (보증금/월세/계약구분) |
| `price_stats` | 최근 N개월(최대 3) 매매 또는 전월세 가격 통계 (최저·중앙값·평균·최고, 평균 평당가). 단지별/전체 집계 선택 가능 |
| `search_presale_trades` | 지역·월 기준 아파트 분양권전매(입주권 포함) 실거래 내역 |
| `search_land_trades` | 지역·월 기준 토지 매매 실거래 내역 (지목/용도지역/거래면적) |
| `search_commercial_trades` | 지역·월 기준 상업업무용 부동산(상가 등) 매매 실거래 내역 (건물유형/주용도/건물면적/층) |
| `search_detached_house_trades` | 지역·월 기준 단독/다가구 주택 매매 실거래 내역 (대지면적/연면적/건축년도) |

모든 도구는 `region`에 "강남구", "성남시 분당구", "수원시 영통구"처럼 시군구명을
자유 텍스트로 받거나, 5자리 법정동코드(LAWD_CD)를 직접 받습니다.

## 설치

```bash
cd realestate-mcp
npm install
```

## API 키 발급

1. [공공데이터포털](https://www.data.go.kr) 회원가입 후 로그인
2. 아래 서비스들을 각각 **활용신청** (전부 개발단계·운영단계 자동승인 — data.go.kr 페이지에 "자동승인"으로 명시돼 있어 즉시 발급됩니다)
   - [국토교통부_아파트 매매 실거래가 상세 자료](https://www.data.go.kr/data/15126468/openapi.do)
   - [국토교통부_아파트 전월세 실거래가 자료](https://www.data.go.kr/data/15126474/openapi.do)
   - [국토교통부_아파트 분양권전매 실거래가 자료](https://www.data.go.kr/data/15126471/openapi.do)
   - [국토교통부_토지 매매 실거래가 자료](https://www.data.go.kr/data/15126466/openapi.do)
   - [국토교통부_상업업무용 부동산 매매 실거래가 자료](https://www.data.go.kr/data/15126463/openapi.do)
   - [국토교통부_단독/다가구 매매 실거래가 자료](https://www.data.go.kr/data/15126465/openapi.do)
   - 서비스마다 별도 신청이 필요하지만, 발급되는 인증키(계정별 서비스키)는 공통이라 하나만 있으면 전부 호출할 수 있습니다. 신청 안 한 서비스를 호출하면 403 Forbidden이 돌아옵니다 — 그 서비스만 추가로 신청하면 됩니다.
3. 마이페이지 → 인증키 발급현황에서 **일반 인증키(Decoding)** 복사
4. 이 폴더에 `key.txt` 파일을 만들고 키를 붙여넣고 저장 (한 줄, 따옴표 없이)
   (또는 환경변수 `REALESTATE_API_KEY`로 설정)

> `key.txt`는 `.gitignore`에 포함되어 있어 GitHub에 올라가지 않습니다.
> 개발계정 트래픽은 기본 10,000회/일이며, 신청 직후에도 실제 반영까지 몇 분 걸릴 수 있습니다.

## Claude Code에 연결

```bash
claude mcp add -s user realestate-mcp -- node "C:\Users\USER\Downloads\realestate-mcp\server.js"
```

## Claude Desktop에 연결

`claude_desktop_config.json`에 추가:

```json
{
  "mcpServers": {
    "realestate-mcp": {
      "command": "node",
      "args": ["C:\\Users\\USER\\Downloads\\realestate-mcp\\server.js"]
    }
  }
}
```

## 사용 예시 (Claude에게 이렇게 물어보세요)

- "강남구 대치동 아파트 최근 실거래가 알려줘"
- "성남시 분당구 2025년 6월 아파트 매매 내역 보여줘"
- "수원시 영통구 전세 시세 어때?"
- "래미안 아파트 매매 내역만 필터링해줘"
- "우리 동네(예: 화성시) 최근 3개월 아파트 시세 통계 내줘"

## 지역명 인식 (LAWD_CD)

국토교통부 API는 지역을 5자리 법정동 시군구코드(LAWD_CD)로 받습니다. 이 서버는
`lawd-codes.js`에 전국 시군구 261개 코드표를 내장해 "강남구", "성남시 분당구"
같은 자유 텍스트를 자동으로 코드로 변환합니다.

- 출처: 행정안전부 법정동코드 전체자료(행정표준코드관리시스템 code.go.kr 원자료를
  재배포한 스냅샷)에서 시군구 단위(10자리 코드 중 읍면동 부분이 0인 행)만 추출.
- "중구"처럼 여러 시도에 동시에 있는 이름은 후보 목록과 함께 더 구체적으로
  입력해달라는 안내를 반환합니다.
- 표에서 못 찾으면 [행정표준코드관리시스템](https://www.code.go.kr/stdcode/regCodeL.do)에서
  5자리 코드를 직접 확인해 그대로 입력하면 됩니다.
- 알려진 한계: 코드표 스냅샷 시점 이후 신설되거나 관할이 바뀐 구·군(예: 2023년
  대구광역시로 편입된 군위군)은 반영되지 않았을 수 있습니다. 전라북도/강원도는
  전북특별자치도/강원특별자치도로 명칭만 최신화했습니다.

## 테스트

```bash
npm test          # 키 없이도 순수 로직 + 프로토콜 동작 확인
```

`test/smoke.js`는 두 부분으로 구성됩니다:
1. 지역코드 해석, 금액/면적 파싱, 평당가 계산, 통계, data.go.kr 오류 응답 파싱 등
   순수 함수를 실제 API 호출 없이 검증
2. 서버를 자식 프로세스로 띄워 MCP 프로토콜(initialize/tools list/tools call)이
   키 없이도 크래시 없이 안내 메시지를 반환하는지 확인

## 원격(HTTP) 배포 — Render로 다른 사람도 키 없이 쓰게 하기

기본은 로컬 stdio 서버(각자 `key.txt`/`REALESTATE_API_KEY` 필요)지만, `PORT` 환경변수가
설정되면 이 서버는 자동으로 **StreamableHTTP 원격 모드**로 전환됩니다. 이걸 Render 같은
곳에 올리면 배포한 사람의 키 하나로 여러 사용자가 각자 키 없이 접속할 수 있습니다.

1. [Render](https://render.com)에 가입 (GitHub 계정으로 가입하면 연동이 빠름)
2. New → Web Service → 이 GitHub repo(`kimju1416/realestate-mcp`) 선택
3. 설정값:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: Free
4. **Environment** 탭에서 환경변수 추가 (여기에 본인 키를 직접 입력 — 코드에는 절대 넣지 않음):
   - `REALESTATE_API_KEY` = (data.go.kr에서 발급받은 본인 인증키)
5. Deploy → 완료되면 `https://<서비스명>.onrender.com` 같은 URL이 생김
6. 다른 사람은 Claude Code에서 원격 MCP로 등록:
   ```bash
   claude mcp add --transport http realestate-remote https://<서비스명>.onrender.com/mcp
   ```
   이러면 각자 API 키 없이 바로 조회 가능합니다.

**알아둘 점**
- 무료 티어는 15분간 요청이 없으면 서버가 잠들고, 그 다음 첫 요청은 30~50초 정도 느릴 수 있습니다 (그 이후엔 정상 속도).
- 남용 방지를 위해 IP당 분당 30회로 요청을 제한합니다 (`server.js`의 `createRateLimiter`).
- 무상태(stateless) 모드라 요청마다 새 세션으로 처리됩니다 — 세션을 유지해야 하는 기능(예: 서버→클라이언트 스트리밍 알림)은 지원하지 않지만, 이 서버의 도구들은 전부 단순 조회형이라 문제 없습니다.
- data.go.kr 개발계정 트래픽 한도(서비스당 하루 10,000건)를 접속자 전원이 나눠 쓰게 됩니다. 하루 수백 건 수준이면 충분하지만, 트래픽이 크게 늘면 운영계정 전환(별도 심사)이 필요할 수 있습니다.

## 참고사항

- 거래금액/보증금/월세는 API에서 "만원" 단위 문자열(쉼표·공백 포함)로 오며, 이 서버가
  숫자로 정리해 "3억 5,000만원" 형태로 표시합니다.
- 아파트 매매 자료는 계약 후 신고 기한(계약일로부터 30일 이내)이 있어, 최근 1개월치는
  아직 자료가 적거나 없을 수 있습니다. 그럴 땐 `dealMonth`를 지난 달로 지정해보세요.
- 실거래 신고 후 취소(해제)된 건은 매매 결과에 `[해제됨]` 표시가 붙습니다.
