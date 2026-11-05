// TEST-ONLY cors shim
export default () => (req, res, next) => { res.setHeader('access-control-allow-origin', '*'); next(); };
