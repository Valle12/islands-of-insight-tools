import index from "./../pages/index.html";
import phasicDialSolver from "./../pages/phasic-dial-solver/index.html";

const server = Bun.serve({
  routes: {
    "/": index,
    "/phasic-dial-solver": phasicDialSolver,
  },
  development: true,
});

console.log(`Listening on http://localhost:${server.port}`);
