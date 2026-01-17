export default {
  async fetch(request: Request, env: any) {
    return new Response(
      JSON.stringify({
        status: "ok",
        message: "Kanichnar Debt Worker is running 🚀"
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  },
};
