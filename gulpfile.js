var argv = require('yargs').argv;
var gulp = require('gulp');
var babel = require('gulp-babel');
var browserSync = require('browser-sync').create();
var sass = require('gulp-sass');
var sourcemaps = require('gulp-sourcemaps');
var removeCode = require('gulp-remove-code');
var inject = require('gulp-inject');
var concat = require('gulp-concat');
var uglify = require('gulp-uglify');
var minifyCss = require('gulp-minify-css');
var minifyHtml = require('gulp-htmlmin');
var logSizes = require('gulp-filesize');
var gulpUtil = require('gulp-util');
var filesize = require('filesize');
var fs = require("fs");
var gzipSize = require('gzip-size');
var aws = require('aws-sdk');
var open = require('open');


var s3 = new aws.S3({
	params: {
		// TODO: use bucket and region from env instead
		Bucket: 'www.nicolasartman.com'
	},
	region: 'us-west-1',
	sslEnabled: true
});

console.log('regions', s3.region, s3.regions);

gulp.task('default', [
	'js',
	'sass',
	'html'
], function () {
	browserSync.init({
		server: {
			baseDir: 'build',
			index: './build/resume.html',
		},
		startPath: '/resume.html'
	});
	
	gulp.watch('src/*.js', ['js', browserSync.reload]);
	gulp.watch('src/*.scss', ['sass']);
	gulp.watch('src/resume.html', ['html', browserSync.reload]);
});


gulp.task('js', function () {
	return gulp.src('src/*.js')
			.pipe(sourcemaps.init())
			.pipe(babel())
			.pipe(concat('resume.js'))
			.pipe(sourcemaps.write('.'))
			.pipe(gulp.dest('build'));
});

gulp.task('sass', function () {
	return gulp.src('src/*.scss')
			.pipe(sourcemaps.init())
			.pipe(sass())
			.pipe(concat('resume.css'))
			.pipe(sourcemaps.write())
			.pipe(gulp.dest('build'))
			.pipe(browserSync.stream());
});

gulp.task('html', function () {
	return gulp.src('src/resume.html')
			.pipe(gulp.dest('build'));
});

var uploadProductionBuildToS3 = function (productionFileBuffer, isProduction, complete) {
	gulpUtil.log('Deploying to production...');
	
	s3.upload({
		'Body': productionFileBuffer,
		'Bucket': 'www.nicolasartman.com',
		'Key': isProduction ? 'resume.html' : 'staged.html',
		'ContentType': 'text/html'
	}, complete);	
}

gulp.task('production', ['js', 'sass', 'html'], function (done) {

	var jsFileStream = gulp.src(['./build/*.js'])
	.pipe(uglify({
				wrap: 'test'
			}));
	var cssFileStream = gulp.src(['./build/*.css'])
			.pipe(minifyCss());

	var stream = gulp.src('build/resume.html')
			// remove all the dev build code includes
			.pipe(removeCode({production: true}))
			// embed the minified production code directly into the page
			.pipe(inject(jsFileStream, {
				starttag: '<!-- inject:js -->',
				transform: function (filePath, file) {
					// return file contents as string
					return '<script>\n(function(){' +
							file.contents.toString('utf8') +
							'}())\n</script>';
				}
			}))
			.pipe(inject(cssFileStream, {
				starttag: '<!-- inject:css -->',
				transform: function (filePath, file) {
					// return file contents as string
					return '<style>\n' + file.contents.toString('utf8') + '\n</style>';
				}
			}))
			.pipe(minifyHtml({
				collapseWhitespace: true,
				removeComments: true,
				conservativeCollapse: true
			}))
			.pipe(gulp.dest('dist'))
			
	stream.on('end', function () {
		// TODO: make more generic

		// Print out file size compression stats!
		var jsSize = fs.statSync('build/resume.js').size;
		var cssSize = fs.statSync('build/resume.css').size;
		var htmlSize = fs.statSync('build/resume.html').size;
		var originalSize = jsSize + cssSize + htmlSize;
		var productionFileBuffer = fs.readFileSync('dist/resume.html');
		var finalSize = gzipSize.sync(productionFileBuffer);

		// TODO: color output
		gulpUtil.log('JS, CSS, and HTML were ' +
				gulpUtil.colors.blue(filesize(originalSize)) +
				' combined.');
		gulpUtil.log('Final HTML file size is ' +
				gulpUtil.colors.green(filesize(finalSize)) + ' gzipped (' +
				gulpUtil.colors.green(Math.round((1 - finalSize / originalSize) * 100) + '%') +
				' compression)');
		
		if (argv.stage) {
			uploadProductionBuildToS3(productionFileBuffer, false, function (error, data) {
				if (data && data['Location']) {
					gulpUtil.log(gulpUtil.colors.green('Staged successfully, ' +
							'opening staged page in browser...'));
					open(data['Location']);
				} else {
					gulpUtil.error('Stage failed!', error);
				}
				done();
			});
		} else if (argv.release) {
			uploadProductionBuildToS3(productionFileBuffer, true, function (error, data) {
				// TODO: invalidate cache and print message
			})
			done();
		}
	})
});
