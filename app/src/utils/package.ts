import pkg from '../../package.json';

pkg.desktopName = pkg.desktopName || (pkg.name ? `${pkg.name}.desktop` : 'MailAr.desktop');

export default pkg;
