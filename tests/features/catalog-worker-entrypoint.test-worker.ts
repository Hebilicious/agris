export default {
  fetch(): Response {
    return new Response("Catalog Worker evidence owner", { status: 404 });
  },
} satisfies ExportedHandler;
