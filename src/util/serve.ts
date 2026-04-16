import index from "./../pages/index.html";
import phasicDialSolver from "./../pages/phasic-dial-solver/index.html";
import rollingBlocksSolver from "./../pages/rolling-blocks-solver/index.html";

const server = Bun.serve({
  routes: {
    "/": index,
    "/phasic-dial-solver": phasicDialSolver,
    "/rolling-blocks-solver": rollingBlocksSolver,
  },
  development: true,
});

console.log(`Listening on http://localhost:${server.port}`);
