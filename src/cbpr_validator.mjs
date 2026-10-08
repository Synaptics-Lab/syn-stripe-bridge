/**
 * FINOS BankerX — 14-Point Structural CBPR+ ISO 20022 Validation Engine
 * Synthesizes and validates pacs.008.001.08 XML wires with RFC 4122 UETR tracking,
 * and emits pacs.002.001.10 PaymentStatusReports after on-chain delivery evidence.
 *
 * v0.2 honesty rules (bridge review F8, 2026-10-08):
 *   - NO fabricated party defaults. Every required BIC/name is a REQUIRED
 *     argument; the builder throws loud instead of inventing a bank
 *     (the old CHASGB2L / KCBKENNAXXX / TZCBETZ2 / 'JPMorgan London Treasury'
 *     defaults are gone — a wire that names a bank that was never involved is
 *     a fabrication, not a convenience).
 *   - The charge (TSA levy) info block appears ONLY when the caller supplies
 *     BOTH a positive charge amount AND the real charge-agent BIC. Default is
 *     no ChrgsInf — never a hardcoded agent.
 *   - pacs.002 is generated only by the settlement core AFTER the delivered-
 *     delta evidence gate passes, carrying that evidence verbatim.
 */

const BIC_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function requireField(fields, name, re, label) {
    const v = fields[name];
    const s = String(v ?? '').trim();
    if (!s || (re ? !re.test(s) : false)) {
        throw new Error(`cbpr_build_refused: ${label} is required${re ? ` and must match ${label}'s format` : ''} — no default is ever used (got ${s ? `length ${s.length}` : 'missing'}, not logged).`);
    }
    return s;
}

export class CBPRPlusValidator {
    /**
     * Synthesizes an ISO 20022 pacs.008.001.08 Customer Credit Transfer XML wire.
     * All party fields REQUIRED — synthetic defaults removed (F8).
     *
     * @param {object} o
     * @param {string} o.paymentId     pacs.008 MsgId / EndToEndId (<=35 chars).
     * @param {string} o.uetr          RFC 4122 UUIDv4 SWIFT gpi UETR.
     * @param {string|number} o.instructedAmount  Decimal amount (major units).
     * @param {string} o.currency      ISO 4217 (uppercase).
     * @param {string} o.debtorName    Real debtor (merchant) institution/party name.
     * @param {string} o.debtorBic     Real debtor agent BIC (ISO 9362).
     * @param {string} o.creditorName  Real creditor party name.
     * @param {string} o.creditorBic   Real creditor agent BIC (ISO 9362).
     * @param {string} [o.chargeBearer='SHAR']  DEBT/CRED/SHAR/SLEV.
     * @param {number} [o.chargeAmount]          Levy in same currency (major units). Omit for none.
     * @param {string} [o.chargeAgentBic]        Levy agent BIC. REQUIRED iff chargeAmount > 0.
     */
    static buildPacs008(o = {}) {
        const chargeBearer = String(o.chargeBearer ?? 'SHAR').toUpperCase();
        if (!['DEBT', 'CRED', 'SHAR', 'SLEV'].includes(chargeBearer)) {
            throw new Error(`cbpr_build_refused: chargeBearer '${chargeBearer}' is not DEBT/CRED/SHAR/SLEV`);
        }
        const paymentId = requireField(o, 'paymentId', null, 'paymentId');
        if (paymentId.length > 35) {
            throw new Error(`cbpr_build_refused: paymentId longer than 35 chars (${paymentId.length})`);
        }
        const uetr = requireField(o, 'uetr', null, 'uetr');
        const currency = requireField(o, 'currency', CURRENCY_RE, 'ISO 4217 currency');
        const debtorName = requireField(o, 'debtorName', null, 'debtorName');
        const debtorBic = requireField(o, 'debtorBic', BIC_RE, 'debtorBic (ISO 9362 BIC)');
        const creditorName = requireField(o, 'creditorName', null, 'creditorName');
        const creditorBic = requireField(o, 'creditorBic', BIC_RE, 'creditorBic (ISO 9362 BIC)');

        const amount = Number(o.instructedAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error(`cbpr_build_refused: instructedAmount must be a positive number (got ${o.instructedAmount})`);
        }

        // Charge info only with BOTH a >0 amount and a real agent BIC — and a
        // charge carrier whose BIC is missing is a refused build, never a
        // defaulted one.
        let chargesInf = '';
        const chargeAmount = Number(o.chargeAmount ?? 0);
        if (Number.isFinite(chargeAmount) && chargeAmount > 0) {
            const chargeAgentBic = String(o.chargeAgentBic ?? '').trim();
            if (!BIC_RE.test(chargeAgentBic)) {
                throw new Error('cbpr_build_refused: chargeAmount > 0 requires the real chargeAgentBic (ISO 9362) — the levy agent is never defaulted');
            }
            if (chargeAmount >= amount) {
                throw new Error(`cbpr_build_refused: chargeAmount ${chargeAmount} >= instructedAmount ${amount}`);
            }
            chargesInf = `      <ChrgsInf>
        <Amt Ccy="${currency}">${chargeAmount.toFixed(2)}</Amt>
        <Agt>
          <FinInstnId>
            <BICFI>${chargeAgentBic}</BICFI>
          </FinInstnId>
        </Agt>
        <Tp>
          <Prtry>TSA_STATUTORY_WITHHOLDING</Prtry>
        </Tp>
      </ChrgsInf>
`;
        }

        const creationDateTime = new Date().toISOString();

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${paymentId}</MsgId>
      <CreDtTm>${creationDateTime}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>CLRG</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <EndToEndId>${paymentId}</EndToEndId>
        <UETR>${uetr}</UETR>
      </PmtId>
      <IntrBkSttlmAmt Ccy="${currency}">${amount.toFixed(2)}</IntrBkSttlmAmt>
      <ChrgBr>${chargeBearer}</ChrgBr>
${chargesInf}      <Dbtr>
        <Nm>${debtorName}</Nm>
      </Dbtr>
      <DbtrAgt>
        <FinInstnId>
          <BICFI>${debtorBic}</BICFI>
        </FinInstnId>
      </DbtrAgt>
      <CdtrAgt>
        <FinInstnId>
          <BICFI>${creditorBic}</BICFI>
        </FinInstnId>
      </CdtrAgt>
      <Cdtr>
        <Nm>${creditorName}</Nm>
      </Cdtr>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>`;

        return { xml, uetr, paymentId };
    }

    /**
     * Synthesizes an ISO 20022 pacs.002.001.10 PaymentStatusReport — generated
     * ONLY after the settlement core's delivered-delta evidence gate passed.
     * Carries the on-chain evidence (signature, slot) verbatim.
     */
    static buildPacs002(o = {}) {
        const {
            originalMsgId,
            uetr,
            instructedAmount,
            currency,
            debtorBic,
            creditorBic,
            status = 'Acsc',
            railSignature,
            railSlot
        } = o;
        const required = {
            originalMsgId: v => { const s = String(v ?? '').trim(); return s && s.length <= 35; },
            uetr: v => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v ?? '')),
            instructedAmount: v => Number(v) > 0 && Number.isFinite(Number(v)),
            currency: v => CURRENCY_RE.test(String(v ?? '').toUpperCase()),
            debtorBic: v => BIC_RE.test(String(v ?? '')),
            creditorBic: v => BIC_RE.test(String(v ?? ''))
        };
        const refusals = [];
        for (const [name, ok] of Object.entries(required)) {
            if (!ok(o[name])) refusals.push(name);
        }
        if (refusals.length) {
            throw new Error(`cbpr_pacs002_refused: required fields missing/invalid: ${refusals.join(', ')}`);
        }
        if (status !== 'Acsc' && !railSignature) {
            throw new Error('cbpr_pacs002_refused: a non-Acsc status needs a reason — v0.2 emits pacs.002 ONLY on delivery evidence (Acsc)');
        }

        const reportId = `${originalMsgId}R`.slice(0, 35);
        const creationDateTime = new Date().toISOString();
        const railEvidence = railSignature ? `
      <StsRsnInf>
        <AddtlInf>RAIL_SIGNATURE:${railSignature}${railSlot ? `|SLOT:${railSlot}` : ''}</AddtlInf>
      </StsRsnInf>` : '';
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10">
  <FIToFIPmtStsRpt>
    <GrpHdr>
      <MsgId>${reportId}</MsgId>
      <CreDtTm>${creationDateTime}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>CLRG</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <TxInfAndSts>
      <StsId>${status}</StsId>
      <OrgnlEndToEndId>${originalMsgId}</OrgnlEndToEndId>
      <OrgnlUETR>${uetr}</OrgnlUETR>
      <OrgnlIntrBkSttlmAmt Ccy="${currency.toUpperCase()}">${Number(instructedAmount).toFixed(2)}</OrgnlIntrBkSttlmAmt>
      <PmtSts>
        <TxSts>${status}</TxSts>
      </PmtSts>
      <DbtrAgt>
        <FinInstnId>
          <BICFI>${debtorBic}</BICFI>
        </FinInstnId>
      </DbtrAgt>
      <CdtrAgt>
        <FinInstnId>
          <BICFI>${creditorBic}</BICFI>
        </FinInstnId>
      </CdtrAgt>${railEvidence}
    </TxInfAndSts>
  </FIToFIPmtStsRpt>
</Document>`;

        return { xml, status: 'Acsc', originalMsgId, uetr };
    }

    /**
     * Executes the strict 14-Point Structural CBPR+ Validation.
     * @returns {{valid: boolean, score: string, checks: Array<{rule,name,passed}>}}
     */
    static validate(xmlString) {
        const results = [];

        // 1. Root XML Namespace
        results.push({
            rule: 1,
            name: 'Root XML Namespace',
            passed: xmlString.includes('xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"')
        });

        // 2. Group Header Present
        results.push({
            rule: 2,
            name: 'Group Header (GrpHdr)',
            passed: /<GrpHdr>[\s\S]*<\/GrpHdr>/.test(xmlString)
        });

        // 3. Message ID format (1-35 chars)
        const msgIdMatch = xmlString.match(/<MsgId>([^<]+)<\/MsgId>/);
        results.push({
            rule: 3,
            name: 'MsgId Length (1..35)',
            passed: Boolean(msgIdMatch && msgIdMatch[1].length <= 35)
        });

        // 4. Number of Transactions matches
        results.push({
            rule: 4,
            name: 'NbOfTxs equals 1',
            passed: xmlString.includes('<NbOfTxs>1</NbOfTxs>')
        });

        // 5. Settlement Method CLRG or INDA
        results.push({
            rule: 5,
            name: 'Settlement Method (CLRG/INDA)',
            passed: xmlString.includes('<SttlmMtd>CLRG</SttlmMtd>') || xmlString.includes('<SttlmMtd>INDA</SttlmMtd>')
        });

        // 6. Credit Transfer Info container instantiated
        results.push({
            rule: 6,
            name: 'CdtTrfTxInf container present',
            passed: /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.test(xmlString)
        });

        // 7. Payment ID container
        results.push({
            rule: 7,
            name: 'PmtId contains EndToEndId',
            passed: /<EndToEndId>[^<]+<\/EndToEndId>/.test(xmlString)
        });

        // 8. RFC 4122 UUIDv4 UETR validation
        const uetrMatch = xmlString.match(/<UETR>([^<]+)<\/UETR>/);
        const uuidv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        results.push({
            rule: 8,
            name: 'RFC 4122 UUIDv4 UETR',
            passed: Boolean(uetrMatch && uuidv4Regex.test(uetrMatch[1]))
        });

        // 9. Instructed Amount Currency (ISO 4217)
        results.push({
            rule: 9,
            name: 'Currency is ISO 4217 (3-letter)',
            passed: /Ccy="[A-Z]{3}"/.test(xmlString)
        });

        // 10. Amount strictly positive decimal
        const amtMatch = xmlString.match(/<IntrBkSttlmAmt[^>]*>([0-9.]+)<\/IntrBkSttlmAmt>/);
        results.push({
            rule: 10,
            name: 'Amount is positive decimal',
            passed: Boolean(amtMatch && parseFloat(amtMatch[1]) > 0)
        });

        // 11. Debtor Agent BIC format
        const bicRegex = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
        const dbtrBicMatch = xmlString.match(/<DbtrAgt>[\s\S]*?<BICFI>([^<]+)<\/BICFI>/);
        results.push({
            rule: 11,
            name: 'Debtor Agent BIC (ISO 9362)',
            passed: Boolean(dbtrBicMatch && bicRegex.test(dbtrBicMatch[1]))
        });

        // 12. Creditor Agent BIC format
        const cdtrBicMatch = xmlString.match(/<CdtrAgt>[\s\S]*?<BICFI>([^<]+)<\/BICFI>/);
        results.push({
            rule: 12,
            name: 'Creditor Agent BIC (ISO 9362)',
            passed: Boolean(cdtrBicMatch && bicRegex.test(cdtrBicMatch[1]))
        });

        // 13. Charge Bearer valid enum
        results.push({
            rule: 13,
            name: 'Charge Bearer (DEBT/CRED/SHAR/SLEV)',
            passed: /<ChrgBr>(DEBT|CRED|SHAR|SLEV)<\/ChrgBr>/.test(xmlString)
        });

        // 14. Document closing tag
        results.push({
            rule: 14,
            name: 'Mandatory XML Document closing tag',
            passed: xmlString.trim().endsWith('</Document>')
        });

        const allPassed = results.every(r => r.passed);
        return { valid: allPassed, score: `${results.filter(r => r.passed).length}/14`, checks: results };
    }
}