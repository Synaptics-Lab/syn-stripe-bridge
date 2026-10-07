/**
 * FINOS BankerX — 14-Point Structural CBPR+ ISO 20022 Validation Engine
 * Synthesizes and validates pacs.008.001.08 XML wires with RFC 4122 UETR tracking.
 */

import { randomUUID } from 'crypto';

export class CBPRPlusValidator {
    /**
     * Synthesizes an ISO 20022 pacs.008.001.08 Customer Credit Transfer XML Wire.
     */
    static buildPacs008({
        paymentId = `BNKX-${Date.now()}`,
        uetr = randomUUID(),
        instructedAmount = 5000.00,
        currency = 'USD',
        debtorName = 'JPMorgan London Treasury',
        debtorBic = 'CHASGB2L',
        creditorName = 'Nairobi Settlement Desk',
        creditorBic = 'KCBKENNAXXX',
        chargeBearer = 'SHAR',
        statutoryTaxAmount = 25.00
    }) {
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
      <IntrBkSttlmAmt Ccy="${currency}">${instructedAmount.toFixed(2)}</IntrBkSttlmAmt>
      <ChrgBr>${chargeBearer}</ChrgBr>
      <ChrgsInf>
        <Amt Ccy="${currency}">${statutoryTaxAmount.toFixed(2)}</Amt>
        <Agt>
          <FinInstnId>
            <BICFI>TZCBETZ2</BICFI>
          </FinInstnId>
        </Agt>
        <Tp>
          <Prtry>TSA_STATUTORY_WITHHOLDING</Prtry>
        </Tp>
      </ChrgsInf>
      <Dbtr>
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
     * Executes the strict 14-Point Structural CBPR+ Validation.
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
