const buffer = Buffer.from('{"test": 123}');
try {
  const result = JSON.parse(buffer);
  console.log("SUCCESS:", result);
} catch(e) {
  console.log("ERROR:", e.message);
  console.log("toString:", buffer.toString());
}
