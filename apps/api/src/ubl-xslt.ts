// The invoice's look (an XSLT the UBL carries, as GİB requires): the integrator and the buyer's e-invoice viewer render
// the XML with it. Plain and printable: seller and buyer, the e-invoice identity (ETTN, profile, type), the lines with KDV,
// the totals and the notes.
export const invoiceXslt = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:n1="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" exclude-result-prefixes="n1 cac cbc">
<xsl:output method="html" encoding="UTF-8" indent="no"/>
<xsl:template name="party">
  <xsl:param name="p"/>
  <b><xsl:value-of select="$p/cac:PartyName/cbc:Name"/><xsl:if test="$p/cac:Person"><xsl:value-of select="$p/cac:Person/cbc:FirstName"/><xsl:text> </xsl:text><xsl:value-of select="$p/cac:Person/cbc:FamilyName"/></xsl:if></b><br/>
  <xsl:value-of select="$p/cac:PostalAddress/cbc:StreetName"/><xsl:text> </xsl:text><xsl:value-of select="$p/cac:PostalAddress/cbc:CitySubdivisionName"/> / <xsl:value-of select="$p/cac:PostalAddress/cbc:CityName"/><br/>
  <xsl:if test="$p/cac:PartyTaxScheme">Vergi Dairesi: <xsl:value-of select="$p/cac:PartyTaxScheme/cac:TaxScheme/cbc:Name"/><br/></xsl:if>
  <xsl:for-each select="$p/cac:PartyIdentification/cbc:ID"><xsl:value-of select="@schemeID"/>: <xsl:value-of select="."/><br/></xsl:for-each>
  <xsl:if test="$p/cbc:WebsiteURI">Web: <xsl:value-of select="$p/cbc:WebsiteURI"/><br/></xsl:if>
  <xsl:if test="$p/cac:Contact/cbc:ElectronicMail">E-posta: <xsl:value-of select="$p/cac:Contact/cbc:ElectronicMail"/></xsl:if>
</xsl:template>
<xsl:template match="/">
<html><head><meta charset="UTF-8"/><title><xsl:value-of select="n1:Invoice/cbc:ID"/></title>
<style>body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 6px}
th{background:#eee;text-align:left}.r{text-align:right}.box{border:1px solid #999;padding:8px;vertical-align:top}.noborder td{border:0}h1{font-size:18px;margin:0 0 8px}</style></head>
<body><xsl:for-each select="n1:Invoice">
<table class="noborder"><tr>
  <td class="box" style="width:50%"><xsl:call-template name="party"><xsl:with-param name="p" select="cac:AccountingSupplierParty/cac:Party"/></xsl:call-template></td>
  <td class="box"><h1><xsl:choose><xsl:when test="cbc:ProfileID='EARSIVFATURA'">e-Arşiv Fatura</xsl:when><xsl:otherwise>e-Fatura</xsl:otherwise></xsl:choose></h1>
    Fatura No: <b><xsl:value-of select="cbc:ID"/></b><br/>Tarih: <xsl:value-of select="cbc:IssueDate"/><xsl:text> </xsl:text><xsl:value-of select="cbc:IssueTime"/><br/>
    Senaryo: <xsl:value-of select="cbc:ProfileID"/><br/>Fatura Tipi: <xsl:value-of select="cbc:InvoiceTypeCode"/><br/>ETTN: <xsl:value-of select="cbc:UUID"/>
    <xsl:if test="cac:BillingReference"><br/>İade edilen fatura: <xsl:value-of select="cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID"/></xsl:if></td>
</tr><tr><td class="box" colspan="2"><u>SAYIN</u><br/><xsl:call-template name="party"><xsl:with-param name="p" select="cac:AccountingCustomerParty/cac:Party"/></xsl:call-template></td></tr></table>
<br/><table><tr><th>#</th><th>Mal / Hizmet</th><th class="r">Miktar</th><th class="r">Birim Fiyat</th><th class="r">KDV %</th><th class="r">KDV</th><th class="r">Tutar</th></tr>
<xsl:for-each select="cac:InvoiceLine"><tr><td><xsl:value-of select="cbc:ID"/></td><td><xsl:value-of select="cac:Item/cbc:Name"/></td>
  <td class="r"><xsl:value-of select="cbc:InvoicedQuantity"/></td><td class="r"><xsl:value-of select="cac:Price/cbc:PriceAmount"/><xsl:text> </xsl:text><xsl:value-of select="cac:Price/cbc:PriceAmount/@currencyID"/></td>
  <td class="r"><xsl:value-of select="cac:TaxTotal/cac:TaxSubtotal/cbc:Percent"/></td><td class="r"><xsl:value-of select="cac:TaxTotal/cbc:TaxAmount"/></td>
  <td class="r"><xsl:value-of select="cbc:LineExtensionAmount"/><xsl:text> </xsl:text><xsl:value-of select="cbc:LineExtensionAmount/@currencyID"/></td></tr></xsl:for-each></table>
<br/><table style="width:45%;margin-left:55%">
<tr><td>Mal Hizmet Toplam Tutarı</td><td class="r"><xsl:value-of select="cac:LegalMonetaryTotal/cbc:LineExtensionAmount"/><xsl:text> </xsl:text><xsl:value-of select="cbc:DocumentCurrencyCode"/></td></tr>
<xsl:for-each select="cac:TaxTotal/cac:TaxSubtotal"><tr><td>Hesaplanan KDV (%<xsl:value-of select="cbc:Percent"/>)</td><td class="r"><xsl:value-of select="cbc:TaxAmount"/></td></tr></xsl:for-each>
<tr><td>Vergiler Dahil Toplam</td><td class="r"><xsl:value-of select="cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount"/></td></tr>
<tr><th>Ödenecek Tutar</th><th class="r"><xsl:value-of select="cac:LegalMonetaryTotal/cbc:PayableAmount"/><xsl:text> </xsl:text><xsl:value-of select="cbc:DocumentCurrencyCode"/></th></tr></table>
<xsl:if test="cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReason"><p>KDV İstisna: <xsl:value-of select="cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReasonCode"/> - <xsl:value-of select="cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:TaxExemptionReason"/></p></xsl:if>
<xsl:for-each select="cbc:Note"><p><xsl:value-of select="."/></p></xsl:for-each>
</xsl:for-each></body></html>
</xsl:template>
</xsl:stylesheet>`;
