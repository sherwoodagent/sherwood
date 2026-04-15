/**
 * Emits a JSON-LD <script> tag for rich-result SEO.
 *
 * Server component — `data` is serialized at render time and injected
 * into the HTML. Input comes from typed server builders in
 * lib/structured-data.ts, but some fields (syndicate name, description)
 * flow from onchain / IPFS metadata and are therefore user-controlled.
 *
 * `JSON.stringify` escapes `"` but NOT `</script>`, so a crafted name
 * could otherwise break out of the inline script tag. Replacing `<`
 * with its JSON unicode escape (`\u003c`) is the standard mitigation —
 * it keeps the payload valid JSON while making `</script>` injection
 * impossible.
 */

interface JsonLdProps {
  data: unknown;
}

export default function JsonLd({ data }: JsonLdProps) {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: payload }}
    />
  );
}
