import { describe, expect, it } from 'vitest';
import { estimateReportCost, mdToHtml } from './report-md';

describe('mdToHtml', () => {
  it('renders headings, paragraphs and inline styles', () => {
    const html = mdToHtml('## Executive Summary\n\nThe team **agreed** on a *plan* with `code`.');
    expect(html).toContain('<h3>Executive Summary</h3>');
    expect(html).toContain('<p>The team <strong>agreed</strong> on a <em>plan</em> with <code>code</code>.</p>');
  });

  it('maps deep headings to h4', () => {
    expect(mdToHtml('### Detail')).toBe('<h4>Detail</h4>');
  });

  it('renders bullet and numbered lists, closing them on blank lines', () => {
    const html = mdToHtml('- one\n- two\n\n1. first\n2) second\n\nafter');
    expect(html).toBe(
      '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol><p>after</p>',
    );
  });

  it('joins consecutive lines into one paragraph', () => {
    expect(mdToHtml('line one\nline two')).toBe('<p>line one line two</p>');
  });

  it('escapes HTML before adding any tags (model/transcript text is untrusted)', () => {
    const html = mdToHtml('## <script>alert(1)</script>\n\n- a & b <img src=x>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
  });

  it('does not treat *emphasis* at line start as a bullet', () => {
    // Bullets require a space after the marker; *word* has none.
    expect(mdToHtml('*important* note')).toBe('<p><em>important</em> note</p>');
  });
});

describe('estimateReportCost', () => {
  const pricing = { base: 0.05, per_minute: 0.002 };

  it('mirrors the server formula: base + per_minute × ceiled minutes, min 1', () => {
    expect(estimateReportCost(pricing, 0)).toBeCloseTo(0.052, 6); // floors at 1 min
    expect(estimateReportCost(pricing, 60)).toBeCloseTo(0.052, 6);
    expect(estimateReportCost(pricing, 61)).toBeCloseTo(0.054, 6); // 2 minutes
    expect(estimateReportCost(pricing, 3600)).toBeCloseTo(0.05 + 0.002 * 60, 6);
    expect(estimateReportCost(pricing, -5)).toBeCloseTo(0.052, 6); // clock skew
  });
});
